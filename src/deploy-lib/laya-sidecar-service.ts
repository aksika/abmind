/**
 * Laya sidecar service management — option-1 warm-up (#1824 stage).
 *
 * `abmind service install/start/restart` ensures the Laya sidecar OS service
 * BEFORE the daemon bootstrap, so the daemon boot probe finds a hot sidecar
 * instead of effective-off. The daemon itself is untouched: it never spawns
 * the sidecar (#1812 contract stands).
 *
 * Rules:
 * - Only when the resolved System One backend is `laya`; jev/off/invalid skip.
 * - The sidecar must never block the daemon: missing venv/script, timeouts,
 *   and contract errors degrade to daemon-only with an actionable message.
 * - A manually-started sidecar already holding the port is respected: the
 *   managed unit is installed for future boots but nothing is bootstrapped
 *   over the live process.
 *
 * All external side effects go through `LayaSidecarDeps` so tests use fakes
 * and never touch the real service manager.
 */

import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { checkLayaHealth, type LayaHealth } from "../judgment-provider.js";
import type { System1Config } from "../system1-config.js";
import type { LaunchdServiceDeps } from "./abmind-launchd-service.js";
import type { DaemonServiceDeps } from "./abmind-daemon-service.js";

// ── Constants ──────────────────────────────────────────────────────────────

export const LAYA_LAUNCHD_LABEL = "ai.abmind.laya-sidecar";
export const LAYA_SYSTEMD_NAME = "laya-sidecar";
export const LAYA_MANAGED_MARKER = "# Managed by abmind (laya sidecar)";
export const LAYA_DEFAULT_PORT = 8765;
/**
 * Cold checkpoint load measured ~23s on MPS with cached weights (2026-09-22,
 * laya 0.3.6); first-time downloads take far longer but those run under the
 * explicit prefetch step, not here. Three minutes bounds a slow host without
 * stalling service setup forever.
 */
export const LAYA_READY_DEADLINE_MS = 180_000;
export const LAYA_READY_POLL_MS = 2_000;

// ── Types ────────────────────────────────────────────────────────────────────

export interface LayaCommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LayaSidecarDeps {
  platform: NodeJS.Platform;
  homeDir: string;
  abmindHome: string;
  fileExists(path: string): boolean;
  writeFile(path: string, content: string, mode: number): void;
  mkdirp(path: string): void;
  command(name: string, args: readonly string[]): LayaCommandResult;
  probeSidecar(url: string, timeoutMs: number): Promise<LayaHealth>;
  delay(ms: number): Promise<void>;
  now(): number;
}

export type LayaEnsureResult =
  | { state: "ready"; detail: string }
  | { state: "skipped"; detail: string }
  | { state: "degraded"; detail: string };

export function defaultLayaSidecarDeps(homeDir: string, abmindHome: string): Pick<LayaSidecarDeps, "probeSidecar" | "delay" | "now"> {
  return {
    probeSidecar: (url, timeoutMs) => checkLayaHealth(url, timeoutMs),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/** Adapt the daemon launchd deps to the sidecar surface (darwin). */
export function layaDepsFromLaunchd(d: LaunchdServiceDeps): LayaSidecarDeps {
  return {
    platform: "darwin",
    homeDir: d.homeDir,
    abmindHome: d.abmindHome,
    fileExists: d.fileExists,
    writeFile: d.writeFile,
    mkdirp: d.mkdirp,
    command: d.command,
    ...defaultLayaSidecarDeps(d.homeDir, d.abmindHome),
  };
}

/** Adapt the daemon systemd deps to the sidecar surface (linux). */
export function layaDepsFromSystemd(d: DaemonServiceDeps, homeDir: string, abmindHome: string): LayaSidecarDeps {
  const fileExists = d.fileExists ?? existsSync;
  return {
    platform: "linux",
    homeDir,
    abmindHome,
    fileExists,
    writeFile: (path, content, mode) => d.writeFileAtomic(path, content, mode),
    mkdirp: (path) => mkdirSync(path, { recursive: true }),
    command: d.command,
    ...defaultLayaSidecarDeps(homeDir, abmindHome),
  };
}

/** Operator-facing one-line report; skipped stays silent. */
export function reportLayaEnsure(result: LayaEnsureResult): void {
  if (result.state === "ready") console.log(`Laya sidecar: ${result.detail}`);
  else if (result.state === "degraded") console.warn(`Laya sidecar degraded: ${result.detail}`);
}

// ── Path resolution ──────────────────────────────────────────────────────────

export function layaVenvPython(homeDir: string): string {
  return join(homeDir, ".laya-venv", "bin", "python");
}

/**
 * Resolve the sidecar script. Dev-clone installs own
 * `<home>/src/abmind/scripts/laya-server.py`; registry releases carry it
 * inside the extracted package. Returns null when neither exists.
 */
export function resolveLayaServerScript(
  abmindHome: string,
  fileExists: (path: string) => boolean,
): string | null {
  const candidates = [
    join(abmindHome, "packages", "standalone", "current", "node_modules", "abmind", "scripts", "laya-server.py"),
    join(abmindHome, "src", "abmind", "scripts", "laya-server.py"),
  ];
  for (const candidate of candidates) {
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

export function layaPortFromUrl(url: string): number {
  try {
    const parsed = new URL(url);
    if (parsed.port !== "") {
      const port = Number(parsed.port);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    }
  } catch {
    // Unparseable here means invalid config; the caller skips on non-on state
    // before reaching this, so fall through to the default.
  }
  return LAYA_DEFAULT_PORT;
}

export function layaLaunchdPlistPath(homeDir: string): string {
  return join(homeDir, "Library", "LaunchAgents", `${LAYA_LAUNCHD_LABEL}.plist`);
}

export function layaSystemdUnitPath(homeDir: string): string {
  return join(homeDir, ".config", "systemd", "user", `${LAYA_SYSTEMD_NAME}.service`);
}

// ── Unit rendering ───────────────────────────────────────────────────────────

export function renderLayaLaunchdPlist(deps: {
  venvPython: string;
  serverScript: string;
  port: number;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAYA_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${deps.venvPython}</string>
    <string>${deps.serverScript}</string>
    <string>--port</string>
    <string>${deps.port}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
}

export function renderLayaSystemdUnit(deps: {
  venvPython: string;
  serverScript: string;
  port: number;
}): string {
  return `${LAYA_MANAGED_MARKER}
[Unit]
Description=Laya System One sidecar for abmind
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${deps.venvPython} ${deps.serverScript} --port ${deps.port}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function isManagedSidecarContent(content: string): boolean {
  return content.includes(LAYA_LAUNCHD_LABEL) || content.includes(LAYA_MANAGED_MARKER);
}

// ── Ensure ───────────────────────────────────────────────────────────────────

/**
 * Ensure a hot Laya sidecar before the daemon starts. Never throws and never
 * blocks daemon setup: every failure mode degrades with an actionable detail.
 */
export async function ensureLayaSidecar(
  deps: LayaSidecarDeps,
  sys1: System1Config,
): Promise<LayaEnsureResult> {
  if (sys1.state !== "on" || sys1.backend !== "laya") {
    return { state: "skipped", detail: "System One backend is not laya; sidecar not managed" };
  }
  if (deps.platform !== "darwin" && deps.platform !== "linux") {
    return { state: "skipped", detail: `platform ${deps.platform} has no sidecar service support` };
  }

  const url = sys1.url;
  const first = await deps.probeSidecar(url, Math.min(sys1.timeoutMs, 10_000));
  if (first.ready) {
    installUnitOnly(deps, sys1);
    return { state: "ready", detail: `sidecar already hot at ${sys1.endpoint}; managed unit ensured for next boot` };
  }

  const venvPython = layaVenvPython(deps.homeDir);
  if (!deps.fileExists(venvPython)) {
    return {
      state: "degraded",
      detail: `laya venv missing at ${venvPython} — daemon continues without judging. Create it per docs/wiki/laya.md`,
    };
  }
  const serverScript = resolveLayaServerScript(deps.abmindHome, deps.fileExists);
  if (!serverScript) {
    return {
      state: "degraded",
      detail: "laya-server.py not found in the release or dev source — daemon continues without judging",
    };
  }

  writeUnit(deps, { venvPython, serverScript, port: layaPortFromUrl(url) });
  const started = startUnit(deps);
  if (!started.ok) return { state: "degraded", detail: `${started.error} — daemon continues without judging` };

  console.log(`Laya sidecar starting (cold load ~25s); waiting for ${sys1.endpoint}...`);
  const deadline = deps.now() + LAYA_READY_DEADLINE_MS;
  for (;;) {
    const health = await deps.probeSidecar(url, Math.min(sys1.timeoutMs, 10_000));
    if (health.ready) {
      return { state: "ready", detail: `sidecar hot at ${sys1.endpoint} (${health.model})` };
    }
    if (health.error === "malformed" || health.error === "contract-mismatch" || (health.error !== undefined && health.error.startsWith("http-"))) {
      // Reachable but speaking the wrong contract — waiting cannot fix it.
      return { state: "degraded", detail: `sidecar at ${sys1.endpoint} reports ${health.error} — daemon continues without judging` };
    }
    if (deps.now() >= deadline) {
      return { state: "degraded", detail: `sidecar at ${sys1.endpoint} not ready within ${LAYA_READY_DEADLINE_MS / 1000}s (${health.error ?? "warming"}) — daemon continues without judging` };
    }
    await deps.delay(LAYA_READY_POLL_MS);
  }
}

function writeUnit(
  deps: LayaSidecarDeps,
  rendered: { venvPython: string; serverScript: string; port: number },
): void {
  if (deps.platform === "darwin") {
    const plistPath = layaLaunchdPlistPath(deps.homeDir);
    deps.mkdirp(join(deps.homeDir, "Library", "LaunchAgents"));
    deps.writeFile(plistPath, renderLayaLaunchdPlist(rendered), 0o644);
  } else {
    const unitPath = layaSystemdUnitPath(deps.homeDir);
    deps.mkdirp(join(deps.homeDir, ".config", "systemd", "user"));
    deps.writeFile(unitPath, renderLayaSystemdUnit(rendered), 0o644);
  }
}

/** Write the managed unit without starting it (port already served). */
function installUnitOnly(deps: LayaSidecarDeps, sys1: System1Config & { state: "on" }): void {
  const venvPython = layaVenvPython(deps.homeDir);
  const serverScript = resolveLayaServerScript(deps.abmindHome, deps.fileExists);
  if (!deps.fileExists(venvPython) || !serverScript) return;
  writeUnit(deps, { venvPython, serverScript, port: layaPortFromUrl(sys1.url) });
  if (deps.platform === "linux") {
    deps.command("systemctl", ["--user", "daemon-reload"]);
    deps.command("systemctl", ["--user", "enable", LAYA_SYSTEMD_NAME]);
  }
}

function startUnit(deps: LayaSidecarDeps): { ok: true } | { ok: false; error: string } {
  if (deps.platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const loaded = deps.command("launchctl", ["print", `gui/${uid}/${LAYA_LAUNCHD_LABEL}`]);
    if (loaded.status === 0) return { ok: true };
    const plistPath = layaLaunchdPlistPath(deps.homeDir);
    const result = deps.command("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
    if (result.status !== 0) {
      return { ok: false, error: `launchctl bootstrap ${LAYA_LAUNCHD_LABEL} failed: ${result.stderr.trim() || result.stdout.trim()}` };
    }
    return { ok: true };
  }
  deps.command("systemctl", ["--user", "daemon-reload"]);
  deps.command("systemctl", ["--user", "enable", LAYA_SYSTEMD_NAME]);
  const result = deps.command("systemctl", ["--user", "start", LAYA_SYSTEMD_NAME]);
  if (result.status !== 0) {
    return { ok: false, error: `systemctl start ${LAYA_SYSTEMD_NAME} failed: ${result.stderr.trim() || result.stdout.trim()}` };
  }
  return { ok: true };
}

// ── Service state query ────────────────────────────────────────────────────
// Supervisor-level liveness for status displays: unit loaded/active and pid.
// Local supervisor queries only — no sidecar HTTP traffic, so `abmind status`
// keeps its no-provider-network-call contract (endpoint truth stays in doctor).

export interface LayaServiceQueryDeps {
  platform: NodeJS.Platform;
  homeDir: string;
  fileExists(path: string): boolean;
  command(name: string, args: readonly string[]): LayaCommandResult;
}

export interface LayaServiceState {
  /** Managed unit file exists (darwin plist / linux unit). */
  installed: boolean;
  /** Supervisor reports the job loaded (darwin) or active (linux). */
  active: boolean;
  /** Process id when the supervisor reports one, else null. */
  pid: number | null;
}

export function queryLayaServiceState(deps: LayaServiceQueryDeps): LayaServiceState {
  const down: LayaServiceState = { installed: false, active: false, pid: null };
  try {
    if (deps.platform === "darwin") {
      const installed = deps.fileExists(layaLaunchdPlistPath(deps.homeDir));
      const listed = deps.command("launchctl", ["list", LAYA_LAUNCHD_LABEL]);
      if (listed.status !== 0) return { ...down, installed };
      const pid = parseLaunchctlListPid(listed.stdout);
      return { installed, active: true, pid };
    }
    if (deps.platform === "linux") {
      const installed = deps.fileExists(layaSystemdUnitPath(deps.homeDir));
      const activeOut = deps.command("systemctl", ["--user", "is-active", LAYA_SYSTEMD_NAME]);
      const active = activeOut.stdout.trim() === "active";
      const pidOut = deps.command("systemctl", ["--user", "show", LAYA_SYSTEMD_NAME, "-p", "MainPID", "--value"]);
      const pid = /^\d+$/.test(pidOut.stdout.trim()) && pidOut.stdout.trim() !== "0"
        ? Number(pidOut.stdout.trim())
        : null;
      return { installed, active, pid };
    }
  } catch {
    // best effort — status displays must never fail on this query
  }
  return down;
}

/**
 * Parse the pid from `launchctl list <label>` output. Modern macOS prints a
 * plist-style dict (`"PID" = 1234;`); older output is tabular
 * (`PID\tStatus\tLabel` plus one row, `-` when not running).
 */
export function parseLaunchctlListPid(stdout: string): number | null {
  const dictMatch = stdout.match(/"PID"\s*=\s*(\d+)\s*;/);
  if (dictMatch?.[1] !== undefined) return Number(dictMatch[1]);
  const lines = stdout.trim().split("\n");
  const row = lines.length > 1 ? lines[1] : lines[0];
  const pid = row?.trim().split(/\s+/)[0];
  return pid !== undefined && pid !== "-" && /^\d+$/.test(pid) ? Number(pid) : null;
}

/** One-line supervisor state for status displays. */
export function describeLayaServiceState(state: LayaServiceState): string {
  if (!state.installed && !state.active) return "not installed";
  if (state.active) return state.pid !== null ? `loaded (pid ${state.pid})` : "loaded";
  return "installed, not loaded";
}

// ── Uninstall ────────────────────────────────────────────────────────────────

/** Remove the managed sidecar unit. Best effort; never touches foreign units. */
export function removeManagedLayaSidecar(deps: LayaSidecarDeps): void {
  try {
    if (deps.platform === "darwin") {
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      deps.command("launchctl", ["bootout", `gui/${uid}/${LAYA_LAUNCHD_LABEL}`]);
    } else if (deps.platform === "linux") {
      deps.command("systemctl", ["--user", "stop", LAYA_SYSTEMD_NAME]);
      deps.command("systemctl", ["--user", "disable", LAYA_SYSTEMD_NAME]);
    }
  } catch {
    // best effort
  }
}
