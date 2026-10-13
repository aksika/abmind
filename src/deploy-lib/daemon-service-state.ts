/**
 * Daemon supervisor state query for status displays.
 *
 * `abmind status` shows whether the daemon is running without requiring a
 * successful RPC negotiation: the supervisor (launchd on macOS, systemd on
 * Linux) is the source of truth when the daemon is stopped or still booting.
 * Local supervisor queries only — no provider traffic.
 *
 * All external side effects go through `DaemonServiceQueryDeps` so tests use
 * fakes and never touch the real service manager.
 */

import { CANONICAL_SERVICE_NAME } from "./abmind-daemon-service.js";
import { parseLaunchctlListPid } from "./laya-sidecar-service.js";

/** Launchd label of the managed abmind daemon job (see renderLaunchdPlist). */
export const DAEMON_LAUNCHD_LABEL = "abmind";

export interface DaemonCommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DaemonServiceQueryDeps {
  platform: NodeJS.Platform;
  uid: number;
  command(name: string, args: readonly string[]): DaemonCommandResult;
}

export interface DaemonServiceState {
  /** Supervisor reports the job loaded (darwin) or active (linux). */
  active: boolean;
  /** Process id when the supervisor reports one, else null. */
  pid: number | null;
}

export function queryDaemonServiceState(deps: DaemonServiceQueryDeps): DaemonServiceState {
  const down: DaemonServiceState = { active: false, pid: null };
  try {
    if (deps.platform === "darwin") {
      const listed = deps.command("launchctl", ["list", DAEMON_LAUNCHD_LABEL]);
      if (listed.status !== 0) return down;
      return { active: true, pid: parseLaunchctlListPid(listed.stdout) };
    }
    if (deps.platform === "linux") {
      const activeOut = deps.command("systemctl", ["--user", "is-active", CANONICAL_SERVICE_NAME]);
      if (activeOut.stdout.trim() !== "active") return down;
      const pidOut = deps.command("systemctl", ["--user", "show", CANONICAL_SERVICE_NAME, "-p", "MainPID", "--value"]);
      const pidText = pidOut.stdout.trim();
      const pid = /^\d+$/.test(pidText) && pidText !== "0" ? Number(pidText) : null;
      return { active: true, pid };
    }
  } catch {
    // best effort — status displays must never fail on this query
  }
  return down;
}

/** Obvious compact supervisor state for status displays: running or stopped. */
export function describeDaemonServiceState(state: DaemonServiceState): string {
  if (!state.active) return "stopped";
  return state.pid !== null ? `running (pid ${state.pid})` : "running";
}
