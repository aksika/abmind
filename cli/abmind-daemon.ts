#!/usr/bin/env node
/**
 * abmind daemon entry — Internal foreground daemon for abmind memory.
 *
 * This module is the compiled entry point invoked by native service supervisors
 * (systemd, launchd). Users should NOT run this directly — use
 * `abmind service {install,start,stop,restart,status}` instead.
 *
 * Without --wait-for-owner: fail-fast when another owner holds the lease.
 * With --wait-for-owner: retry lease acquisition every 5s on OwnerLeaseError
 * and start serving once the lease is acquired. Intended for systemd/launchd
 * supervision where the daemon should adopt ownership gracefully after a
 * manually-started daemon exits.
 *
 * #1701: SIGINT/SIGTERM only REQUEST shutdown (one shared AbortController +
 * one memoized cleanup promise). This entry never calls process.exit() itself;
 * the direct CLI wrapper exits only after runDaemon() resolves, so timed-out
 * work cannot continue after the owner lease is released.
 */

import { loadMemoryConfig, type MemoryConfig } from "../src/memory-config.js";
import { AbmindServiceHost } from "../src/abmind-service-host.js";
import { OwnerLeaseError } from "../src/abmind-owner-lease.js";
import { LocalEndpointServer } from "../src/local-endpoint-server.js";
import { SignedWssEndpoint } from "../src/remote/signed-wss-endpoint.js";
import { createShutdownDeadline, remainingMs, serviceDrainEnd } from "../src/daemon-shutdown-contract.js";
import { logError, logInfo, logWarn } from "../src/mem-logger.js";

const HELP = `abmind daemon entry — Internal foreground daemon

This entry is invoked by native service supervisors (systemd/launchd). For
normal operation, use 'abmind service {install,start,stop,restart,status}'.

Usage: node dist/cli/abmind-daemon.js [options]

Options:
  --help              Show this help
  --foreground        Run in foreground (default; intentional under launchd/systemd supervision)
  --socket PATH       Socket path (default: ~/.abmind/run/abmind.sock)
  --principal peer_uid|self  Principal mapping (default: self)
  --wait-for-owner    Retry owner lease acquisition every 5s until it succeeds
                      (intended for supervised adoption)

The daemon acquires the #1379 exclusive owner lease, initializes the
memory manager, and listens for V1 protocol requests on the Unix socket.
Shutdown order (#1701): reject new calls, cancel sleep work, quiesce
listeners, drain accepted requests, flush responses, close DB, release lease —
all inside one absolute deadline that finishes before the supervisor's kill
timeout.
`;

export interface DaemonOptions {
  socketPath?: string;
  principalMapping: "peer_uid" | "self";
  waitForOwner: boolean;
}

export interface DaemonDeps {
  abortableDelay(ms: number, signal: AbortSignal): Promise<void>;
  onSignal(sig: string, handler: () => void): void;
}

export async function runDaemon(config: MemoryConfig, opts: DaemonOptions, deps: DaemonDeps): Promise<void> {
  // #1701: signals only request shutdown through one controller. The first
  // signal logs; later signals join silently instead of racing their own
  // cleanup paths.
  const shutdownController = new AbortController();
  const shutdownSignal = shutdownController.signal;
  let firstSignalName: string | null = null;
  let cleanupPromise: Promise<void> | null = null;

  let host: AbmindServiceHost | null = null;
  let server: LocalEndpointServer | null = null;
  let wssEndpoint: SignedWssEndpoint | null = null;

  const requestShutdown = (signalName: string): void => {
    if (!firstSignalName) {
      firstSignalName = signalName;
      logInfo("daemon", `Shutting down (${signalName})`);
    }
    shutdownController.abort();
  };

  deps.onSignal("SIGINT", () => requestShutdown("SIGINT"));
  deps.onSignal("SIGTERM", () => requestShutdown("SIGTERM"));

  const awaitShutdownRequest = (): Promise<void> =>
    shutdownSignal.aborted
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
        shutdownSignal.addEventListener("abort", () => resolve(), { once: true });
      });

  /**
   * One memoized cleanup owns every teardown phase against ONE absolute
   * deadline (quiesce -> drain -> flush -> release). A repeated signal or a
   * second caller awaits this same promise; no phase receives a fresh timeout.
   */
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async (): Promise<void> => {
      const deadline = createShutdownDeadline(Date.now());
      try {
        host?.beginShutdown();
        server?.quiesce();
        wssEndpoint?.quiesce();

        // Accepted work drains within its own limit, never past the
        // pre-reserve boundary of the shared budget.
        const drainBudget = remainingMs(deadline, Date.now(), serviceDrainEnd(deadline));
        const drained = host
          ? await host.drainAcceptedWork(drainBudget)
          : { drained: true, remainingInFlight: 0 };
        if (!drained.drained) {
          logWarn("daemon", `Service drain expired with ${drained.remainingInFlight} accepted dispatch(es) after ${Date.now() - deadline.startedAt}ms; continuing bounded cleanup`);
        }

        // Transports flush completed responses concurrently within the time
        // left before the reserved release tail.
        const flushBudget = remainingMs(deadline, Date.now(), deadline.releaseBy);
        await Promise.all([
          server ? server.stop(flushBudget) : undefined,
          wssEndpoint ? wssEndpoint.stop(flushBudget) : undefined,
        ]);
      } finally {
        // Manager close + owner-lease release run exactly once, even when an
        // earlier phase expired or threw.
        try {
          await host?.finishStop();
        } finally {
          host = null;
          server = null;
          wssEndpoint = null;
        }
      }
    })();
    return cleanupPromise;
  };

  // ── Owner acquisition (#1379) ─────────────────────────────────────────────
  for (let attempt = 1; ; attempt++) {
    if (shutdownSignal.aborted) break;

    const candidate = new AbmindServiceHost({
      mode: "daemon",
      memory: config,
      policy: { principalId: "daemon", role: "service", grantedDomains: ["system", "private", "operational", "operator"], authenticatedBy: "embedded" },
    });
    host = candidate;
    try {
      await candidate.start();
      logInfo("daemon", "Abmind daemon started");
      break; // owned!
    } catch (err) {
      host = null;
      // A shutdown requested during startup is a normal exit path, never a
      // startup failure: cleanup awaits the startup rollback below.
      if (shutdownSignal.aborted) break;

      if (opts.waitForOwner && err instanceof OwnerLeaseError) {
        logInfo("daemon", `Owner lease not available (attempt ${attempt}), retrying in 5s...`);
        // Abortable delay: a signal wakes this immediately instead of
        // waiting out another retry tick.
        await deps.abortableDelay(5_000, shutdownSignal);
        continue;
      }

      logError("daemon", "Failed to start daemon", err);
      throw err;
    }
  }

  if (host === null || !host.started) {
    // Shutdown was requested before/at ownership: finish the shared cleanup
    // (which also awaits any in-flight startup rollback) and return normally.
    await cleanup();
    return;
  }

  // ── Endpoints ──────────────────────────────────────────────────────────────
  server = new LocalEndpointServer({
    socketPath: opts.socketPath,
    service: host.service!,
    principalMapping: opts.principalMapping,
    allowPrivateDelegation: true,
  });

  if (shutdownSignal.aborted) {
    await cleanup();
    return;
  }

  try {
    await server.start();
    logInfo("daemon", `Listening on ${server.address}`);
  } catch (err) {
    logError("daemon", "Failed to start endpoint server", err);
    await cleanup();
    throw err;
  }

  if (shutdownSignal.aborted) {
    await cleanup();
    return;
  }

  // Optional WSS remote endpoint (#1381) — best effort, never fatal.
  try {
    wssEndpoint = new SignedWssEndpoint(host.service!);
    await wssEndpoint.start();
    if (wssEndpoint.isStarted) {
      logInfo("daemon", "Signed WSS endpoint started");
    }
  } catch (err) {
    logError("daemon", "Failed to start WSS endpoint (remote serving disabled)", err);
    wssEndpoint = null;
  }

  // Block until shutdown is requested, then join the shared cleanup.
  await awaitShutdownRequest();
  await cleanup();
}

// ── Direct CLI entry (when invoked as `node dist/cli/abmind-daemon.js`) ────
//
// #1701: guarded to direct execution so lifecycle tests can import runDaemon()
// without launching a daemon, mutating global argv handling, or registering
// real signal handlers at import time.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

function invokedAsMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  if (import.meta.url === pathToFileURL(entry).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedAsMainModule()) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(HELP);
    process.exit(0);
  }

  function argValue(name: string): string | undefined {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : undefined;
  }

  const config = loadMemoryConfig();
  const defaultOpts: DaemonOptions = {
    socketPath: argValue("--socket"),
    waitForOwner: args.includes("--wait-for-owner"),
    principalMapping: args.includes("--principal")
      ? (argValue("--principal") === "peer_uid" ? "peer_uid" as const : "self" as const)
      : "self" as const,
  };

  const defaultDeps: DaemonDeps = {
    abortableDelay: (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
      if (signal.aborted) { resolve(); return; }
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    }),
    onSignal: (sig: string, handler: () => void) => process.on(sig, handler),
  };

  try {
    await runDaemon(config, defaultOpts, defaultDeps);
    // #1701: exit only after runDaemon() resolved — lease released, socket and
    // resources closed. Timed-out promises cannot keep this process alive.
    process.exit(0);
  } catch (err) {
    logError("daemon", "Fatal error", err);
    process.exit(1);
  }
}
