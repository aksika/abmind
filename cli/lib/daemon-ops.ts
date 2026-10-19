/**
 * Daemon lifecycle operations shared by `abmind start|stop|restart` and the
 * deprecated `abmind service` shim. One implementation, two entry points —
 * the shim warns and forwards here.
 */

import { existsSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { abmindHome } from "../../src/mem-paths.js";
import { getAbmindEnv, type AbmindEnvConfig } from "../../src/env-schema.js";
import { readCurrentOwnerLease } from "../../src/abmind-owner-lease.js";
import { CANONICAL_SERVICE_NAME, defaultDeps as linuxDefaultDeps } from "../../src/deploy-lib/abmind-daemon-service.js";
import {
  stopLaunchAgentSafe,
  uninstallLaunchAgent,
  launchdPlistPath,
  createHealthProbe,
  type LaunchdServiceDeps,
} from "../../src/deploy-lib/abmind-launchd-service.js";
import { queryDaemonServiceState, describeDaemonServiceState } from "../../src/deploy-lib/daemon-service-state.js";

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";

/**
 * Read the env singleton without the one-time init log line — status-style
 * commands own their full stdout, so the `N vars loaded` notice stays out.
 * Real errors still print: only this single call is muted.
 */
export function quietEnv(): AbmindEnvConfig {
  const orig = console.error;
  console.error = () => {};
  try {
    return getAbmindEnv();
  } finally {
    console.error = orig;
  }
}

export function buildLaunchdDeps(): LaunchdServiceDeps {
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
      // spawnSync with explicit piped stdio — never inherit. See
      // abmind-service-reconciler.ts: execFileSync forwards launchctl's
      // raw stderr ("Bootstrap failed: 5: Input/output error") to the user's
      // terminal on the transient exit-5 case, even when retry recovers.
      const r = spawnSync(name, args, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return {
        status: r.status ?? 1,
        stdout: r.stdout?.trim() ?? "",
        stderr: r.stderr?.trim() ?? "",
      };
    },
    probeHealth: createHealthProbe(
      quietEnv().localEndpoint,
    ),
    delay: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
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

function daemonSupervisorSummary(): string {
  try {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const state = queryDaemonServiceState({
      platform: process.platform,
      uid,
      command: (name, args) => {
        const r = spawnSync(name, args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        return { status: r.status ?? 1, stdout: r.stdout?.trim() ?? "", stderr: r.stderr?.trim() ?? "" };
      },
    });
    return `abmind daemon is ${describeDaemonServiceState(state)}.`;
  } catch { return "abmind daemon state unknown."; }
}

export async function daemonInstall(): Promise<void> {
  const { reconcileDaemonService } = await import("../../src/deploy-lib/abmind-service-reconciler.js");
  const result = await reconcileDaemonService({
    releaseChanged: false,
    activeRelease: { version: "", commit: null, releaseId: "" },
    start: true,
  });
  if (result.state === "failed") {
    console.error(result.reason);
    process.exit(1);
  } else if (result.state === "unsupported") {
    console.error(result.reason);
    process.exit(1);
  } else if (result.state === "ready") {
    if (isLinux) {
      console.log(`systemd unit installed: ${linuxDefaultDeps().canonicalUnitPath}`);
    } else if (isMac) {
      console.log(`LaunchAgent installed: ${launchdPlistPath(homedir())}`);
    }
    console.log(`Service: ${result.action}`);
    console.log("Run 'abmind status' to verify.");
  } else if (result.state === "needs-linger") {
    console.log(`systemd unit installed: ${linuxDefaultDeps().canonicalUnitPath}`);
    console.log(`! Linger not enabled — daemon stops on logout. Run: ${result.remediation}`);
  }
}

export function daemonUninstall(): void {
  const homeDir = homedir();
  try {
    if (isLinux) {
      execFileSync("systemctl", ["--user", "stop", CANONICAL_SERVICE_NAME], { stdio: "ignore" });
      execFileSync("systemctl", ["--user", "disable", CANONICAL_SERVICE_NAME], { stdio: "ignore" });
      const unitPath = join(homedir(), ".config", "systemd", "user", `${CANONICAL_SERVICE_NAME}.service`);
      try { unlinkSync(unitPath); } catch { /* best effort */ }
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      console.log("systemd user unit removed.");
    } else if (isMac) {
      uninstallLaunchAgent(buildLaunchdDeps());
      const plistPath = launchdPlistPath(homeDir);
      try { unlinkSync(plistPath); } catch { /* best effort */ }
      console.log("LaunchAgent removed.");
    }
  } catch { /* best effort */ }
}

export async function daemonStart(): Promise<void> {
  const { reconcileDaemonService } = await import("../../src/deploy-lib/abmind-service-reconciler.js");
  const result = await reconcileDaemonService({
    releaseChanged: false,
    activeRelease: { version: "", commit: null, releaseId: "" },
    start: true,
  });
  if (result.state === "failed" || result.state === "unsupported") {
    console.error(result.reason);
    process.exit(1);
  }
  console.log("abmind daemon started.");
}

export function daemonStop(): void {
  if (isLinux) {
    execFileSync("systemctl", ["--user", "stop", CANONICAL_SERVICE_NAME], { stdio: "inherit" });
  } else if (isMac) {
    const result = stopLaunchAgentSafe(buildLaunchdDeps());
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
  }
  console.log("abmind daemon stopped.");
}

export async function daemonRestart(): Promise<void> {
  const { reconcileDaemonService } = await import("../../src/deploy-lib/abmind-service-reconciler.js");
  const result = await reconcileDaemonService({
    releaseChanged: true,
    activeRelease: { version: "", commit: null, releaseId: "" },
    start: true,
  });
  if (result.state === "failed" || result.state === "unsupported") {
    console.error(result.reason);
    process.exit(1);
  }
  console.log("abmind daemon restarted.");
}

/** Supervisor-level daemon line for the `service status` shim and diagnostics. */
export function daemonStatusLines(): string[] {
  if (isLinux || isMac) {
    return [daemonSupervisorSummary()];
  }
  return ["Unsupported platform"];
}
