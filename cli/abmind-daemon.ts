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
 */

import { loadMemoryConfig, type MemoryConfig } from "../src/memory-config.js";
import { AbmindServiceHost } from "../src/abmind-service-host.js";
import { OwnerLeaseError } from "../src/abmind-owner-lease.js";
import { LocalEndpointServer } from "../src/local-endpoint-server.js";
import { SignedWssEndpoint } from "../src/remote/signed-wss-endpoint.js";
import { logError, logInfo } from "../src/mem-logger.js";

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
Shutdown order: reject new calls, drain, close listener, close DB, release lease.
`;

export interface DaemonOptions {
  socketPath?: string;
  principalMapping: "peer_uid" | "self";
  waitForOwner: boolean;
}

export interface DaemonDeps {
  createSignal(): AbortSignal;
  abortableDelay(ms: number, signal: AbortSignal): Promise<void>;
  onSignal(sig: string, handler: () => void): void;
}

export async function runDaemon(config: MemoryConfig, opts: DaemonOptions, deps: DaemonDeps): Promise<void> {
  const signal = deps.createSignal();
  let host: AbmindServiceHost | null = null;
  let server: LocalEndpointServer | null = null;
  let wssEndpoint: SignedWssEndpoint | null = null;

  function cleanup(): Promise<void> {
    return (async () => {
      if (wssEndpoint) { await wssEndpoint.stop(); wssEndpoint = null; }
      if (server) { await server.stop(); server = null; }
      if (host) { await host.stop(); host = null; }
    })();
  }

  // Signal handlers for clean shutdown during wait loop and normal operation
  deps.onSignal("SIGINT", async () => {
    logInfo("daemon", "Shutting down (SIGINT)");
    // Manually abort the AbortController if we have one
    await cleanup();
    process.exit(0);
  });
  deps.onSignal("SIGTERM", async () => {
    logInfo("daemon", "Shutting down (SIGTERM)");
    await cleanup();
    process.exit(0);
  });

  // Retry loop for wait-for-owner
  for (let attempt = 1; ; attempt++) {
    if (signal.aborted) {
      await cleanup();
      process.exit(0);
    }

    host = new AbmindServiceHost({
      mode: "daemon",
      memory: config,
      policy: { principalId: "daemon", role: "service", grantedDomains: ["system", "private", "operational", "operator"], authenticatedBy: "embedded" },
    });

    try {
      await host.start();
      logInfo("daemon", "Abmind daemon started");
      break; // owned!
    } catch (err) {
      await host.stop();
      host = null;

      if (opts.waitForOwner && err instanceof OwnerLeaseError) {
        logInfo("daemon", `Owner lease not available (attempt ${attempt}), retrying in 5s...`);
        await deps.abortableDelay(5_000, signal);
        continue;
      }

      logError("daemon", "Failed to start daemon", err);
      await cleanup();
      process.exit(1);
    }
  }

  // Start endpoint server
  const socketIndex = process.argv.indexOf("--socket");
  const socketPath = socketIndex !== -1 ? process.argv[socketIndex + 1] : undefined;
  const principalMapping = process.argv.includes("--principal")
    ? (process.argv[process.argv.indexOf("--principal") + 1] === "peer_uid" ? "peer_uid" as const : "self" as const)
    : "self" as const;

  server = new LocalEndpointServer({
    socketPath,
    service: host.service!,
    principalMapping,
    allowPrivateDelegation: true,
  });

  try {
    await server.start();
    logInfo("daemon", `Listening on ${server.address}`);
  } catch (err) {
    logError("daemon", "Failed to start endpoint server", err);
    await cleanup();
    process.exit(1);
  }

  // Start optional WSS remote endpoint (#1381)
  if (host.service) {
    try {
      wssEndpoint = new SignedWssEndpoint(host.service);
      await wssEndpoint.start();
      if (wssEndpoint.isStarted) {
        logInfo("daemon", "Signed WSS endpoint started");
      }
    } catch (err) {
      logError("daemon", "Failed to start WSS endpoint (remote serving disabled)", err);
      wssEndpoint = null;
    }
  }

  // Block until signal
  await new Promise<void>(() => {});
}

// ── Direct CLI entry (when invoked as `node dist/cli/abmind-daemon.js`) ────

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}

const config = loadMemoryConfig();
const defaultOpts: DaemonOptions = {
  waitForOwner: args.includes("--wait-for-owner"),
  principalMapping: args.includes("--principal")
    ? (args[args.indexOf("--principal") + 1] === "peer_uid" ? "peer_uid" as const : "self" as const)
    : "self" as const,
};

const defaultDeps: DaemonDeps = {
  createSignal: () => {
    const controller = new AbortController();
    return controller.signal;
  },
  abortableDelay: (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  }),
  onSignal: (sig: string, handler: () => void) => process.on(sig, handler),
};

try {
  await runDaemon(config, defaultOpts, defaultDeps);
} catch (err) {
  logError("daemon", "Fatal error", err);
  process.exit(1);
}
