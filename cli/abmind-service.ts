#!/usr/bin/env node
/**
 * abmind service — deprecated shim (#1920).
 *
 * Daemon lifecycle moved to top-level `abmind start|stop|restart`; the Laya
 * sidecar moved to `abmind laya ...`. This entry warns on stderr and forwards
 * to the same operations so existing scripts keep working.
 */

import {
  daemonInstall,
  daemonUninstall,
  daemonStart,
  daemonStop,
  daemonRestart,
  daemonStatusLines,
} from "./lib/daemon-ops.js";

const HELP = `abmind service — DEPRECATED, use 'abmind start|stop|restart' and 'abmind laya ...'

Subcommands (forwarded):
  install     Install the service unit (use 'abmind start')
  uninstall   Remove the service unit
  start       Start the daemon (use 'abmind start')
  stop        Stop the daemon (use 'abmind stop')
  restart     Restart the daemon (use 'abmind restart')
  status      Show daemon + laya supervisor state (use 'abmind status')
`;

const subcommand = process.argv[2];
if (!subcommand || subcommand === "--help") {
  console.log(HELP);
  process.exit(0);
}

process.stderr.write("abmind service is deprecated — use 'abmind start|stop|restart' and 'abmind laya ...'\n");

async function run(): Promise<void> {
  switch (subcommand) {
    case "install":
      await daemonInstall();
      break;
    case "uninstall":
      daemonUninstall();
      break;
    case "start":
      await daemonStart();
      break;
    case "stop":
      daemonStop();
      break;
    case "restart":
      await daemonRestart();
      break;
    case "status": {
      const lines = daemonStatusLines();
      for (const line of lines) console.log(line);
      if (lines[0] === "Unsupported platform") process.exit(1);
      break;
    }
    default:
      console.error(`Unknown subcommand: ${subcommand}\nRun 'abmind service --help' for usage.`);
      process.exit(1);
  }
}

await run();
