#!/usr/bin/env node
/**
 * abmind service — Manage the abmind daemon as a native user service.
 *
 * On Linux: reconciles the canonical systemd --user unit at
 *   ~/.config/systemd/user/abmind-daemon.service via the shared
 *   ensureDaemonService module.
 *
 * On macOS: manages a per-user LaunchAgent via the shared launchd module.
 */

import { existsSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { abmindHome } from "../src/mem-paths.js";
import { getAbmindEnv } from "../src/env-schema.js";
import { readCurrentOwnerLease } from "../src/abmind-owner-lease.js";
import { CANONICAL_SERVICE_NAME, defaultDeps as linuxDefaultDeps } from "../src/deploy-lib/abmind-daemon-service.js";
import {
  stopLaunchAgentSafe,
  statusLaunchAgent,
  uninstallLaunchAgent,
  launchdPlistPath,
  createHealthProbe,
  type LaunchdServiceDeps,
} from "../src/deploy-lib/abmind-launchd-service.js";

const HELP = `abmind service — Manage the abmind daemon as a native user service

Subcommands:
  install     Install the service unit (systemd --user on Linux, launchd on macOS)
  uninstall   Remove the service unit
  start       Start the service
  stop        Stop the service
  restart     Restart the service
  status      Show service status

On Linux: manages the systemd --user unit at:
  ~/.config/systemd/user/abmind-daemon.service
  Logs: journalctl --user -u abmind-daemon

On macOS: manages a per-user LaunchAgent.
  Logs: log show --predicate 'process == "abmind"'
`;

const subcommand = process.argv[2];
if (!subcommand || subcommand === "--help") {
  console.log(HELP);
  process.exit(0);
}

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";
const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const homeDir = homedir();
const ah = abmindHome();

function launchdDeps(): LaunchdServiceDeps {
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
      } catch (err: any) {
        return {
          status: err.status ?? 1,
          stdout: err.stdout?.trim() ?? "",
          stderr: err.stderr?.trim() ?? "",
        };
      }
    },
    probeHealth: createHealthProbe(
      getAbmindEnv().localEndpoint,
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

// ── Dispatch ──────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  switch (subcommand) {
    case "install": {
      const { reconcileDaemonService } = await import("../src/deploy-lib/abmind-service-reconciler.js");
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
        console.log("Run 'abmind service status' to verify.");
      } else if (result.state === "needs-linger") {
        console.log(`systemd unit installed: ${linuxDefaultDeps().canonicalUnitPath}`);
        console.log(`! Linger not enabled — daemon stops on logout. Run: ${result.remediation}`);
      }
      break;
    }

    case "uninstall": {
      try {
        if (isLinux) {
          execFileSync("systemctl", ["--user", "stop", CANONICAL_SERVICE_NAME], { stdio: "ignore" });
          execFileSync("systemctl", ["--user", "disable", CANONICAL_SERVICE_NAME], { stdio: "ignore" });
          const unitPath = join(homedir(), ".config", "systemd", "user", `${CANONICAL_SERVICE_NAME}.service`);
          try { unlinkSync(unitPath); } catch { /* best effort */ }
          execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
          console.log("systemd user unit removed.");
        } else if (isMac) {
          uninstallLaunchAgent(launchdDeps());
          const plistPath = launchdPlistPath(homeDir);
          try { unlinkSync(plistPath); } catch { /* best effort */ }
          console.log("LaunchAgent removed.");
        }
      } catch { /* best effort */ }
      break;
    }

    case "start": {
      const { reconcileDaemonService } = await import("../src/deploy-lib/abmind-service-reconciler.js");
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
      break;
    }

    case "stop": {
      if (isLinux) {
        execFileSync("systemctl", ["--user", "stop", CANONICAL_SERVICE_NAME], { stdio: "inherit" });
      } else if (isMac) {
        const result = stopLaunchAgentSafe(launchdDeps());
        if (!result.ok) {
          console.error(result.error);
          process.exit(1);
        }
      }
      console.log("abmind daemon stopped.");
      break;
    }

    case "restart": {
      const { reconcileDaemonService } = await import("../src/deploy-lib/abmind-service-reconciler.js");
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
      break;
    }

    case "status": {
      if (isLinux) {
        execFileSync("systemctl", ["--user", "status", CANONICAL_SERVICE_NAME], { stdio: "inherit" });
      } else if (isMac) {
        const result = statusLaunchAgent(launchdDeps());
        if (result.status !== 0) {
          console.log("abmind daemon is not running.");
        } else {
          console.log(result.stdout);
        }
      } else {
        console.error("Unsupported platform");
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown subcommand: ${subcommand}\nRun 'abmind service --help' for usage.`);
      process.exit(1);
  }
}

await run();
