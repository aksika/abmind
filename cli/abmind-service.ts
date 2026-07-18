#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { abmindHome } from "../src/mem-paths.js";

const HELP = `abmind service — Manage the abmind daemon as a native user service

Subcommands:
  install     Install the service unit (systemd --user on Linux, launchd on macOS)
  uninstall   Remove the service unit
  start       Start the service
  stop        Stop the service
  restart     Restart the service
  status      Show service status

On Linux: installs a systemd --user unit.
  Logs: journalctl --user -u abmind
On macOS: installs a per-user LaunchAgent.
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

function serviceName(): string {
  return "abmind";
}

function binaryPath(): string {
  const here = new URL(import.meta.url).pathname;
  return join(here, "..", "..", "dist", "cli", "abmind.js");
}

// ── systemd user unit ─────────────────────────────────────────────────────

function systemdUnitPath(): string {
  const unitDir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  return join(unitDir, `${serviceName()}.service`);
}

function writeSystemdUnit(): void {
  const unit = `[Unit]
Description=abmind memory daemon
After=network.target

[Service]
Type=exec
ExecStart=${binaryPath()} daemon
Restart=on-failure
RestartSec=5
StartLimitBurst=5
StartLimitIntervalSec=30
Environment=ABMIND_HOME=${abmindHome()}

[Install]
WantedBy=default.target
`;
  writeFileSync(systemdUnitPath(), unit, "utf-8");
}

// ── launchd plist ─────────────────────────────────────────────────────────

function launchdPlistPath(): string {
  const agentDir = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(agentDir, { recursive: true });
  return join(agentDir, `${serviceName()}.plist`);
}

function writeLaunchdPlist(): void {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${serviceName()}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binaryPath()}</string>
    <string>daemon</string>
  </array>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ABMIND_HOME</key>
    <string>${abmindHome()}</string>
  </dict>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
  writeFileSync(launchdPlistPath(), plist, "utf-8");
}

// ── Dispatch ──────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  switch (subcommand) {
    case "install": {
      if (isLinux) {
        writeSystemdUnit();
        execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
        console.log(`systemd user unit installed: ${systemdUnitPath()}`);
        console.log("Run 'abmind service start' to start the daemon.");
      } else if (isMac) {
        writeLaunchdPlist();
        console.log(`LaunchAgent installed: ${launchdPlistPath()}`);
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
          execFileSync("systemctl", ["--user", "stop", serviceName()], { stdio: "ignore" });
          execFileSync("systemctl", ["--user", "disable", serviceName()], { stdio: "ignore" });
          unlinkSync(systemdUnitPath());
          execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
          console.log("systemd user unit removed.");
        } else if (isMac) {
          execFileSync("launchctl", ["bootout", `gui/${uid}/${serviceName()}`], { stdio: "ignore" });
          unlinkSync(launchdPlistPath());
          console.log("LaunchAgent removed.");
        }
      } catch { /* best effort */ }
      break;
    }

    case "start": {
      if (isLinux) {
        execFileSync("systemctl", ["--user", "start", serviceName()], { stdio: "inherit" });
      } else if (isMac) {
        execFileSync("launchctl", ["bootstrap", `gui/${uid}`, launchdPlistPath()], { stdio: "inherit" });
      }
      console.log("abmind daemon started.");
      break;
    }

    case "stop": {
      if (isLinux) {
        execFileSync("systemctl", ["--user", "stop", serviceName()], { stdio: "inherit" });
      } else if (isMac) {
        execFileSync("launchctl", ["bootout", `gui/${uid}/${serviceName()}`], { stdio: "inherit" });
      }
      console.log("abmind daemon stopped.");
      break;
    }

    case "restart": {
      if (isLinux) {
        execFileSync("systemctl", ["--user", "restart", serviceName()], { stdio: "inherit" });
      } else if (isMac) {
        execFileSync("launchctl", ["bootout", `gui/${uid}/${serviceName()}`], { stdio: "ignore" });
        execFileSync("launchctl", ["bootstrap", `gui/${uid}`, launchdPlistPath()], { stdio: "inherit" });
      }
      console.log("abmind daemon restarted.");
      break;
    }

    case "status": {
      if (isLinux) {
        execFileSync("systemctl", ["--user", "status", serviceName()], { stdio: "inherit" });
      } else if (isMac) {
        try {
          const out = execFileSync("launchctl", ["print", `gui/${uid}/${serviceName()}`], { encoding: "utf-8" });
          console.log(out);
        } catch {
          console.log("abmind daemon is not running.");
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
