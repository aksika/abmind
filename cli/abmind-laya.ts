#!/usr/bin/env node
/**
 * abmind laya — Manage the Laya System One sidecar as a native user service.
 *
 * The sidecar is the only `service` abmind manages: a supervised
 * laya-server.py (launchd on macOS, systemd --user on Linux) that serves
 * System One judgment requests on loopback. The abmind daemon never spawns
 * it (#1812 contract stands) — these commands drive the supervisor directly.
 *
 * Supervisor queries only — no sidecar HTTP traffic; endpoint truth stays
 * in `abmind doctor`.
 */

import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { abmindHome } from "../src/mem-paths.js";
import { resolveSystem1Config, describeSystem1Config } from "../src/system1-config.js";
import { buildLaunchdDeps, quietEnv } from "./lib/daemon-ops.js";
import { defaultDeps as linuxDefaultDeps } from "../src/deploy-lib/abmind-daemon-service.js";
import {
  ensureLayaSidecar,
  reportLayaEnsure,
  layaDepsFromLaunchd,
  layaDepsFromSystemd,
  queryLayaServiceState,
  describeLayaServiceState,
  removeManagedLayaSidecar,
  layaLaunchdPlistPath,
  layaSystemdUnitPath,
  LAYA_LAUNCHD_LABEL,
  LAYA_SYSTEMD_NAME,
  type LayaSidecarDeps,
} from "../src/deploy-lib/laya-sidecar-service.js";

const HELP = `abmind laya — Manage the Laya System One sidecar service

Subcommands:
  install     Write the managed unit and start the sidecar
  uninstall   Stop and remove the managed sidecar unit
  start       Start the sidecar (writes the managed unit first)
  stop        Stop the sidecar (unit file stays for next boot)
  restart     Restart the sidecar
  status      Show sidecar supervisor state

On Linux: manages the systemd --user unit at:
  ~/.config/systemd/user/laya-sidecar.service

On macOS: manages a per-user LaunchAgent.
`;

const subcommand = process.argv[2];
if (!subcommand || subcommand === "--help") {
  console.log(HELP);
  process.exit(0);
}

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";

function sidecarDeps(): LayaSidecarDeps {
  const homeDir = homedir();
  const ah = abmindHome();
  if (isLinux) return layaDepsFromSystemd(linuxDefaultDeps(), homeDir, ah);
  const launchd = buildLaunchdDeps();
  return layaDepsFromLaunchd(launchd);
}

function unitPath(): string {
  const homeDir = homedir();
  return isLinux ? layaSystemdUnitPath(homeDir) : layaLaunchdPlistPath(homeDir);
}

function stopUnit(): boolean {
  const deps = sidecarDeps();
  if (isLinux) {
    const r = deps.command("systemctl", ["--user", "stop", LAYA_SYSTEMD_NAME]);
    return r.status === 0;
  }
  if (isMac) {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const r = deps.command("launchctl", ["bootout", `gui/${uid}/${LAYA_LAUNCHD_LABEL}`]);
    return r.status === 0 || r.stderr.includes("Could not find service") || r.stderr.includes("No such process");
  }
  return false;
}

async function run(): Promise<void> {
  switch (subcommand) {
    case "install":
    case "start":
    case "restart": {
      if (!isLinux && !isMac) {
        console.error(`platform ${process.platform} does not have sidecar service support`);
        process.exit(1);
      }
      if (subcommand !== "install") stopUnit();
      const deps = sidecarDeps();
      const result = await ensureLayaSidecar(deps, resolveSystem1Config(quietEnv()));
      reportLayaEnsure(result);
      if (result.state !== "ready") {
        if (result.state === "skipped") console.error(`laya ${subcommand} skipped: ${result.detail}`);
        process.exit(1);
      }
      break;
    }

    case "stop": {
      if (!isLinux && !isMac) {
        console.error(`platform ${process.platform} does not have sidecar service support`);
        process.exit(1);
      }
      if (!stopUnit()) {
        console.error("failed to stop the laya sidecar service");
        process.exit(1);
      }
      console.log("laya sidecar stopped.");
      break;
    }

    case "uninstall": {
      if (isLinux || isMac) {
        stopUnit();
        removeManagedLayaSidecar(sidecarDeps());
        try { unlinkSync(unitPath()); } catch { /* best effort */ }
        console.log("laya sidecar unit removed.");
      } else {
        console.error(`platform ${process.platform} does not have sidecar service support`);
        process.exit(1);
      }
      break;
    }

    case "status": {
      if (!isLinux && !isMac) {
        console.error(`platform ${process.platform} does not have sidecar service support`);
        process.exit(1);
      }
      console.log(`  system1:       ${describeSystem1Config(resolveSystem1Config(quietEnv()))}`);
      try {
        const state = queryLayaServiceState(sidecarDeps());
        console.log(`  laya service:  ${describeLayaServiceState(state)}`);
      } catch {
        console.log("  laya service:  unknown");
      }
      break;
    }

    default:
      console.error(`Unknown subcommand: ${subcommand}\nRun 'abmind laya --help' for usage.`);
      process.exit(1);
  }
}

await run();
