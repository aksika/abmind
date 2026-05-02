/** Standalone paths for abmind. */

import { resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export function abmindHome(): string {
  const raw = process.env.ABMIND_HOME ?? resolve(homedir(), ".abmind");
  return raw.startsWith("~") ? resolve(homedir(), raw.slice(1).replace(/^[/\\]/, "")) : raw;
}

/** Directory for Kiro hook sidecar files + error logs (#344). */
export function abmindHooksDir(): string {
  return resolve(abmindHome(), "hooks");
}

/** Path for extraction pending marker (#366). */
export function extractionPendingPath(): string {
  return resolve(abmindHooksDir(), "extraction-pending.marker");
}

/** Path for extraction failure counter (#366). */
export function extractionFailuresPath(): string {
  return resolve(abmindHooksDir(), "extraction-failures.json");
}

/** Path for the hook error log (errors from wakeup/recall/store hooks). */
export function hookErrorLogPath(): string {
  return resolve(abmindHooksDir(), "errors.log");
}

/**
 * Derive a stable sidecar key for the current Kiro session.
 * Preferred: KIRO_SESSION_ID env var (set by Kiro CLI, stable across all hooks
 * in one session). Fallback: hash of cwd+date (coarse; collides only on same
 * directory + same day + missing env var). Last resort: constant string.
 */
export function hookSidecarKey(): string {
  const kiroId = process.env.KIRO_SESSION_ID?.trim();
  if (kiroId) return kiroId;
  const cwd = process.cwd();
  const date = new Date().toISOString().slice(0, 10);
  return "fallback-" + createHash("sha256").update(cwd + date).digest("hex").slice(0, 16);
}

/** Path to the sidecar file holding the most recent user prompt for this session. */
export function hookSidecarPath(): string {
  return resolve(abmindHooksDir(), `last-prompt-${hookSidecarKey()}.txt`);
}
