/**
 * macOS launchd service manager for abmind daemon (#1458).
 *
 * All external side effects go through `LaunchdServiceDeps` so tests use
 * fakes and never touch the real service manager.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type HealthProbeResult =
  | { state: "ready" }
  | { state: "unavailable"; detail: string }
  | { state: "terminal"; detail: string };

export interface LaunchdServiceDeps {
  readonly uid: number;
  readonly homeDir: string;
  readonly abmindHome: string;
  readonly serviceModuleUrl: string;
  fileExists(path: string): boolean;
  writeFile(path: string, content: string, mode: number): void;
  mkdirp(path: string): void;
  command(name: string, args: readonly string[]): CommandResult;
  probeHealth(): Promise<HealthProbeResult>;
  delay(ms: number): Promise<void>;
  now(): number;
}

// ── Constants ────────────────────────────────────────────────────────────────

export const PROBE_DEADLINE_MS = 10_000;
export const PROBE_INTERVAL_MS = 500;

// ── Path resolution ──────────────────────────────────────────────────────────

/**
 * Resolve `abmind.js` as the sibling of the running service module.
 *
 * In a standalone release both live in `<package>/dist/cli/`; in a source build
 * they live in the corresponding CLI output directory. This removes the extra
 * hard-coded `dist` segment that generated Molty's nonexistent
 * `dist/dist/cli/abmind.js` path.
 */
export function resolveLaunchdDispatcher(serviceModuleUrl: string): string {
  return join(dirname(fileURLToPath(serviceModuleUrl)), "abmind.js");
}

// ── XML escaping ─────────────────────────────────────────────────────────────

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── Plist rendering ──────────────────────────────────────────────────────────

export function renderLaunchdPlist(deps: {
  dispatcherPath: string;
  abmindHome: string;
}): string {
  const dispatcher = xmlEscape(deps.dispatcherPath);
  const home = xmlEscape(deps.abmindHome);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>abmind</string>
  <key>ProgramArguments</key>
  <array>
    <string>${dispatcher}</string>
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
    <string>${home}</string>
  </dict>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

// ── Plist path ───────────────────────────────────────────────────────────────

export function launchdPlistPath(homeDir: string): string {
  return join(homeDir, "Library", "LaunchAgents", "abmind.plist");
}

// ── Install ───────────────────────────────────────────────────────────────────

export interface InstallResult {
  ok: true;
  plistPath: string;
  dispatcherPath: string;
}

export function installLaunchAgent(deps: LaunchdServiceDeps): InstallResult | { ok: false; error: string } {
  const dispatcherPath = resolveLaunchdDispatcher(deps.serviceModuleUrl);
  if (!deps.fileExists(dispatcherPath)) {
    return { ok: false, error: `Dispatcher not found at: ${dispatcherPath}\nRun 'abmind install' first.` };
  }

  const plistPath = launchdPlistPath(deps.homeDir);
  const plistDir = dirname(plistPath);
  if (!deps.fileExists(plistDir)) {
    deps.mkdirp(plistDir);
  }

  const content = renderLaunchdPlist({ dispatcherPath, abmindHome: deps.abmindHome });
  deps.writeFile(plistPath, content, 0o644);

  return { ok: true, plistPath, dispatcherPath };
}

// ── Start ─────────────────────────────────────────────────────────────────────

export type StartResult = {
  ok: true;
} | {
  ok: false;
  error: string;
};

export async function startLaunchAgent(deps: LaunchdServiceDeps): Promise<StartResult> {
  const plistPath = launchdPlistPath(deps.homeDir);
  const dispatcherPath = resolveLaunchdDispatcher(deps.serviceModuleUrl);

  if (!deps.fileExists(dispatcherPath)) {
    return { ok: false, error: `Dispatcher not found at: ${dispatcherPath}\nRun 'abmind service install' first.` };
  }
  if (!deps.fileExists(plistPath)) {
    return { ok: false, error: `LaunchAgent plist not found at: ${plistPath}\nRun 'abmind service install' first.` };
  }

  const result = deps.command("launchctl", ["bootstrap", `gui/${deps.uid}`, plistPath]);
  if (result.status !== 0) {
    return { ok: false, error: `launchctl bootstrap failed (exit ${result.status}): ${result.stderr.trim() || result.stdout.trim()}` };
  }

  // Bounded readiness probe
  const deadline = deps.now() + PROBE_DEADLINE_MS;
  let lastDetail = "Daemon not yet reachable";

  while (deps.now() < deadline) {
    const probe = await deps.probeHealth();
    if (probe.state === "ready") return { ok: true };
    if (probe.state === "terminal") {
      return {
        ok: false,
        error: `${probe.detail}\nInspect: launchctl print gui/${deps.uid}/abmind`,
      };
    }
    lastDetail = probe.detail;
    await deps.delay(PROBE_INTERVAL_MS);
  }

  return {
    ok: false,
    error: `abmind daemon did not become ready within ${PROBE_DEADLINE_MS / 1000}s: ${lastDetail}\nInspect: launchctl print gui/${deps.uid}/abmind`,
  };
}

/**
 * Check whether a launchctl bootout failure indicates an absent (not loaded)
 * job that should be treated as success for idempotent operations.
 */
export function isAbsentBootoutError(stderr: string): boolean {
  return stderr.includes("Could not find service") || stderr.includes("No such process") || stderr.includes("Operation now in progress");
}

// ── Stop ──────────────────────────────────────────────────────────────────────

export function stopLaunchAgent(deps: LaunchdServiceDeps): CommandResult {
  return deps.command("launchctl", ["bootout", `gui/${deps.uid}/abmind`]);
}

/**
 * Idempotent stop: succeeds even when the LaunchAgent is already absent.
 * Returns a StartResult-style discriminated union for direct CLI use.
 */
export function stopLaunchAgentSafe(deps: LaunchdServiceDeps): { ok: true } | { ok: false; error: string } {
  const result = stopLaunchAgent(deps);
  if (result.status !== 0 && !isAbsentBootoutError(result.stderr)) {
    return { ok: false, error: `launchctl bootout failed (exit ${result.status}): ${result.stderr.trim() || result.stdout.trim()}` };
  }
  return { ok: true };
}

// ── Restart ───────────────────────────────────────────────────────────────────

export async function restartLaunchAgent(deps: LaunchdServiceDeps): Promise<StartResult> {
  const bootout = deps.command("launchctl", ["bootout", `gui/${deps.uid}/abmind`]);
  if (bootout.status !== 0) {
    if (!isAbsentBootoutError(bootout.stderr)) {
      return { ok: false, error: `launchctl bootout failed (exit ${bootout.status}): ${bootout.stderr.trim() || bootout.stdout.trim()}` };
    }
  }

  return startLaunchAgent(deps);
}

// ── Status ────────────────────────────────────────────────────────────────────

export function statusLaunchAgent(deps: LaunchdServiceDeps): CommandResult {
  return deps.command("launchctl", ["print", `gui/${deps.uid}/abmind`]);
}

// ── Uninstall ─────────────────────────────────────────────────────────────────

export function uninstallLaunchAgent(deps: LaunchdServiceDeps): void {
  deps.command("launchctl", ["bootout", `gui/${deps.uid}/abmind`]);
}

// ── Production health probe ───────────────────────────────────────────────────

export function createHealthProbe(localEndpoint: string): () => Promise<HealthProbeResult> {
  return async (): Promise<HealthProbeResult> => {
    let transport: import("../local-transport.js").LocalTransport | null = null;
    try {
      const { LocalTransport } = await import("../local-transport.js");
      const { AbmindClient } = await import("../abmind-client.js");

      transport = new LocalTransport(localEndpoint);
      const client = new AbmindClient(transport);

      let caps;
      try {
        caps = await client.system.negotiate();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Could not connect to daemon") || msg.includes("ECONNREFUSED") || msg.includes("ENOENT")) {
          return { state: "unavailable", detail: msg };
        }
        return { state: "terminal", detail: `Negotiation failed: ${msg}` };
      }

      if (!caps.methods?.includes("system.health")) {
        return { state: "terminal", detail: "Daemon does not support system.health" };
      }

      let health;
      try {
        health = await client.system.health();
      } catch (err) {
        return { state: "terminal", detail: `Health check failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      if (health.status !== "healthy") {
        return { state: "unavailable", detail: `Daemon status: ${health.status}` };
      }
      if (!health.memoryEnabled) {
        return { state: "unavailable", detail: "Daemon memory not enabled" };
      }

      return { state: "ready" };
    } finally {
      if (transport) {
        await transport.close();
      }
    }
  };
}
