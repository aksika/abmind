/**
 * Shared platform daemon service reconciler (#1477).
 *
 * Unifies Linux systemd and macOS launchd service management into one
 * dispatcher. Callers (install, update, service CLI) route through this
 * instead of duplicating OS branching.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { abmindHome } from "../mem-paths.js";
import { getAbmindEnv } from "../env-schema.js";
import { readCurrentOwnerLease } from "../abmind-owner-lease.js";
import {
  activeDaemonEntry,
  renderLaunchdPlist,
  launchdPlistPath,
  stopOrphanedDaemon,
  isAbsentBootoutError,
  isTransientBootstrapError,
  createHealthProbe,
  PROBE_DEADLINE_MS,
  PROBE_INTERVAL_MS,
  BOOTSTRAP_RETRY_ATTEMPTS,
  BOOTSTRAP_RETRY_DELAY_MS,
  type LaunchdServiceDeps,
} from "./abmind-launchd-service.js";
import {
  ensureDaemonService,
  defaultDeps as linuxDefaultDeps,
  type EnsureDaemonServiceOptions,
} from "./abmind-daemon-service.js";

export interface ActiveReleaseIdentity {
  version: string;
  commit: string | null;
  releaseId: string;
}

export type ReconcileResult =
  | { state: "ready"; action: "started" | "restarted" | "already-running"; runtime: ActiveReleaseIdentity }
  | { state: "needs-linger"; remediation: string }
  | { state: "failed"; reason: string }
  | { state: "unsupported"; reason: string };

export interface ReconcileInput {
  releaseChanged: boolean;
  activeRelease: ActiveReleaseIdentity;
  start: boolean;
}

// ── Darwin helpers ──────────────────────────────────────────────────────────

function darwinDeps(expected: ActiveReleaseIdentity): LaunchdServiceDeps {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const homeDir = homedir();
  const ah = abmindHome();
  return {
    uid,
    homeDir,
    abmindHome: ah,
    serviceModuleUrl: import.meta.url,
    nodeExecutable: process.execPath,
    fileExists: existsSync,
    writeFile: (path, content, mode) => writeFileSync(path, content, { encoding: "utf-8", mode }),
    mkdirp: (path) => mkdirSync(path, { recursive: true }),
    command: (name, args) => {
      try {
        const r = execFileSync(name, args, { encoding: "utf-8" });
        return { status: 0, stdout: r?.trim() ?? "", stderr: "" };
      } catch (err: unknown) {
        const details = err as { status?: unknown; stdout?: unknown; stderr?: unknown };
        return {
          status: typeof details.status === "number" ? details.status : 1,
          stdout: typeof details.stdout === "string" ? details.stdout.trim() : "",
          stderr: typeof details.stderr === "string" ? details.stderr.trim() : "",
        };
      }
    },
    probeHealth: createHealthProbe(getAbmindEnv().localEndpoint, {
      version: expected.version || undefined,
      buildCommit: expected.commit || undefined,
      releaseId: expected.releaseId || undefined,
    }),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    readOwnerLease: () => {
      const record = readCurrentOwnerLease(join(ah, "memory", "memory.db"));
      return record ? { pid: record.pid } : null;
    },
    isProcessAlive: (pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    },
    terminateProcess: (pid, signal) => {
      try { process.kill(pid, signal); } catch { /* already gone */ }
    },
  };
}

async function reconcileDarwin(
  input: ReconcileInput,
): Promise<ReconcileResult> {
  const deps = darwinDeps(input.activeRelease);
  const ah = abmindHome();
  const stableEntry = activeDaemonEntry(ah);
  const plistPath = launchdPlistPath(homedir());

  // Write the managed plist using the stable current path (never derives
  // the daemon entry from the loaded CLI module URL — production plist
  // generation uses the standalone layout only).
  const plistDir = join(homedir(), "Library", "LaunchAgents");
  if (!existsSync(plistDir)) mkdirSync(plistDir, { recursive: true });

  const content = renderLaunchdPlist({
    nodeExecutable: process.execPath,
    daemonEntryPath: stableEntry,
    abmindHome: ah,
  });
  writeFileSync(plistPath, content, { encoding: "utf-8", mode: 0o644 });

  // Pre-check: if daemon is already running the correct release, skip restart
  let action: "started" | "restarted" | "already-running" = "started";
  if (!input.releaseChanged) {
    const alreadyOK = await identityCheck(input.activeRelease);
    if (alreadyOK) {
      return {
        state: "ready",
        action: "already-running",
        runtime: input.activeRelease,
      };
    }
    action = "restarted";
  }

  // ── Bootstrap the daemon ─────────────────────────────────────────────────
  // Inline bootout/bootstrap logic rather than using startLaunchAgent(),
  // because that function resolves the daemon entry from its caller's module
  // URL, which would point at deploy-lib/ instead of cli/.

  // 1. Stop any unsupervised daemon holding the owner lease
  const orphan = await stopOrphanedDaemon(deps);
  if (!orphan.stopped && orphan.reason === "timeout") {
    return { state: "failed", reason: `Existing daemon pid ${orphan.pid} did not exit — stop it manually before retrying` };
  }

  // 2. Boot out any existing job (absent errors are tolerated)
  const bootout = deps.command("launchctl", ["bootout", `gui/${deps.uid}/abmind`]);
  if (bootout.status !== 0 && !isAbsentBootoutError(bootout.stderr)) {
    return { state: "failed", reason: `launchctl bootout failed: ${bootout.stderr.trim() || bootout.stdout.trim()}` };
  }

  // 3. Bootstrap with the managed plist (retry transient exit-5 errors)
  let result = deps.command("launchctl", ["bootstrap", `gui/${deps.uid}`, plistPath]);
  for (let attempt = 0; result.status !== 0 && isTransientBootstrapError(result.status, result.stderr) && attempt < BOOTSTRAP_RETRY_ATTEMPTS; attempt++) {
    await deps.delay(BOOTSTRAP_RETRY_DELAY_MS);
    result = deps.command("launchctl", ["bootstrap", `gui/${deps.uid}`, plistPath]);
  }
  if (result.status !== 0) {
    return { state: "failed", reason: `launchctl bootstrap failed: ${result.stderr.trim() || result.stdout.trim()}` };
  }

  // 4. Bounded readiness probe (also verifies release identity via createHealthProbe)
  const deadline = deps.now() + PROBE_DEADLINE_MS;
  let lastDetail = "Daemon not yet reachable";

  while (deps.now() < deadline) {
    const probe = await deps.probeHealth();
    if (probe.state === "ready") break;
    if (probe.state === "terminal") {
      return { state: "failed", reason: probe.detail };
    }
    lastDetail = probe.detail;
    await deps.delay(PROBE_INTERVAL_MS);
  }

  if (deps.now() >= deadline) {
    return { state: "failed", reason: `Daemon did not become ready within ${PROBE_DEADLINE_MS / 1000}s: ${lastDetail}` };
  }

  return {
    state: "ready",
    action: input.releaseChanged ? "restarted" : action,
    runtime: input.activeRelease,
  };
}

// ── Platform dispatcher ─────────────────────────────────────────────────────

export async function reconcileDaemonService(
  input: ReconcileInput,
): Promise<ReconcileResult> {
  const platform = process.platform;

  if (platform === "linux") {
    const deps = linuxDefaultDeps();
    const opts: EnsureDaemonServiceOptions = {
      dryRun: false,
      releaseChanged: input.releaseChanged,
      start: input.start,
    };
    const result = ensureDaemonService(deps, opts);

    switch (result.state) {
      case "ready":
        return {
          state: "ready",
          action: result.action,
          runtime: input.activeRelease,
        };
      case "needs-linger":
        return { state: "needs-linger", remediation: result.remediation };
      case "existing-owner":
        return {
          state: "ready",
          action: "started",
          runtime: input.activeRelease,
        };
      default:
        return { state: "unsupported", reason: result.reason ?? "unknown" };
    }
  }

  if (platform === "darwin") {
    return reconcileDarwin(input);
  }

  return { state: "unsupported", reason: `platform ${platform} does not have native daemon service support` };
}

/** Check whether the running daemon reports the expected release identity. */
async function identityCheck(expected: ActiveReleaseIdentity): Promise<boolean> {
  try {
    const { LocalTransport } = await import("../local-transport.js");
    const { AbmindClient } = await import("../abmind-client.js");
    const transport = new LocalTransport(getAbmindEnv().localEndpoint);
    const client = new AbmindClient(transport);
    try {
      const status = await client.system.status();
      return (!expected.version || status.version === expected.version)
        && (!expected.commit || status.buildCommit === expected.commit)
        && (!expected.releaseId || status.releaseId === expected.releaseId);
    } finally {
      await transport.close();
    }
  } catch {
    return false;
  }
}
