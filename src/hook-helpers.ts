/**
 * Shared helpers for Kiro hook subcommands (#344).
 *
 * Hook subcommands must NEVER block the user's chat turn. On any unexpected
 * failure, they write to the error log and exit 0 with empty stdout. The
 * error log is surfaced via `abmind hook doctor` and `abmind status`.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { abmindHooksDir, hookErrorLogPath } from "./mem-paths.js";

/** Append a timestamped entry to the hook error log. Never throws. */
export function logHookError(hookName: string, err: unknown): void {
  try {
    const ts = new Date().toISOString();
    const msg = err instanceof Error ? err.message : String(err);
    const line = `${ts} [${hookName}] ${msg}\n`;
    mkdirSync(dirname(hookErrorLogPath()), { recursive: true });
    appendFileSync(hookErrorLogPath(), line);
  } catch {
    // If even the error log write fails, silently give up — don't block the hook.
  }
}

/** Ensure the hooks dir exists. Never throws. */
export function ensureHooksDir(): void {
  try {
    mkdirSync(abmindHooksDir(), { recursive: true });
  } catch {
    // Ignore — individual writers will surface their own errors if needed.
  }
}

/** Read and parse JSON from stdin. Returns null on any error. */
export async function readStdinJson<T = unknown>(): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", () => {
      if (!buf.trim()) { resolve(null); return; }
      try { resolve(JSON.parse(buf) as T); }
      catch { resolve(null); }
    });
    process.stdin.on("error", () => resolve(null));
    // If stdin closed already with no data, resolve null after tick
    setTimeout(() => {
      if (!buf) resolve(null);
    }, 100);
  });
}

/** Whether hooks are globally disabled via env var. */
export function hooksDisabled(): boolean {
  const v = process.env.ABMIND_HOOKS_DISABLED?.toLowerCase().trim();
  return v === "true" || v === "1" || v === "yes";
}
