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

import { existsSync, unlinkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { abmindHome } from "../src/mem-paths.js";
import { CANONICAL_SERVICE_NAME, LEGACY_UNIT_PATH, MANAGED_MARKER, ensureDaemonService, defaultDeps, renderUnitContent, resolveDispatcherPath } from "../src/deploy-lib/abmind-daemon-service.js";
import {
  installLaunchAgent,
  startLaunchAgent,
  restartLaunchAgent,
  stopLaunchAgent,
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
      process.env["ABMIND_ENDPOINT"] ?? join(ah, "run", "abmind.sock"),
    ),
    delay: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

// ── Dispatch ──────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  switch (subcommand) {
    case "install": {
      if (isLinux) {
        const deps = defaultDeps();
        const result = ensureDaemonService(deps, { dryRun: false, releaseChanged: false, start: true });
        if (result.state === "unsupported") {
          console.log(`systemd unit: ${result.reason}`);
          process.exit(1);
        } else if (result.state === "ready") {
          console.log(`systemd unit installed: ${deps.canonicalUnitPath}`);
          console.log(`Service: ${result.action}`);
          if (result.unitChanged) {
            console.log("Run 'abmind service status' to verify.");
          }
        } else if (result.state === "existing-owner") {
          console.log(`systemd unit installed: ${deps.canonicalUnitPath}`);
          console.log("Manual daemon detected — adopting after it exits.");
        } else if (result.state === "needs-linger") {
          console.log(`systemd unit installed: ${deps.canonicalUnitPath}`);
          console.log(`! Linger not enabled — daemon stops on logout. Run: ${result.remediation}`);
        }
      } else if (isMac) {
        const result = installLaunchAgent(launchdDeps());
        if (!result.ok) {
          console.error(result.error);
          process.exit(1);
        }
        console.log(`LaunchAgent installed: ${result.plistPath}`);
        console.log("Run 'abmind service start' to start the daemon.");
      } else {
        console.error("Unsupported platform for service installation");
        process.exit(1);
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
      if (isLinux) {
        execFileSync("systemctl", ["--user", "start", CANONICAL_SERVICE_NAME], { stdio: "inherit" });
        console.log("abmind daemon started.");
      } else if (isMac) {
        const result = await startLaunchAgent(launchdDeps());
        if (!result.ok) {
          console.error(result.error);
          process.exit(1);
        }
        console.log("abmind daemon started.");
      }
      break;
    }

    case "stop": {
      if (isLinux) {
        execFileSync("systemctl", ["--user", "stop", CANONICAL_SERVICE_NAME], { stdio: "inherit" });
      } else if (isMac) {
        const result = stopLaunchAgent(launchdDeps());
        if (result.status !== 0) {
          console.error(`launchctl bootout failed (exit ${result.status}): ${result.stderr || result.stdout}`);
          process.exit(1);
        }
      }
      console.log("abmind daemon stopped.");
      break;
    }

    case "restart": {
      if (isLinux) {
        execFileSync("systemctl", ["--user", "restart", CANONICAL_SERVICE_NAME], { stdio: "inherit" });
        console.log("abmind daemon restarted.");
      } else if (isMac) {
        const result = await restartLaunchAgent(launchdDeps());
        if (!result.ok) {
          console.error(result.error);
          process.exit(1);
        }
        console.log("abmind daemon restarted.");
      }
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
