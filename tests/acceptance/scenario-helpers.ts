import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AcceptanceFailure, ScenarioResult } from "./contracts.js";

export function pass(name: string, durationMs: number, requestIds: string[]): ScenarioResult {
  return { name, state: "passed", durationMs, requestIds };
}

export function fail(name: string, durationMs: number, requestIds: string[], failure: AcceptanceFailure): ScenarioResult {
  return { name, state: "failed", durationMs, requestIds, failure };
}

export function makeRequestIds(...ids: string[]): string[] {
  return ids;
}

/** Seed the production sleep prompt set into a disposable acceptance home. */
export function seedSleepPrompts(repositoryRoot: string, abmindHome: string): void {
  const source = join(repositoryRoot, "templates", "prompts", "sleep");
  if (!existsSync(source)) {
    throw new Error(`Acceptance fixture sleep prompts missing: ${source}`);
  }
  cpSync(source, join(abmindHome, "prompts", "sleep"), { recursive: true });
}

/**
 * Unix socket path ceiling for acceptance fixtures (#1841). macOS enforces a
 * 104-char sun_path limit, Linux 108; fixture roots live under $TMPDIR, which
 * is ~50 chars alone on macOS, so every fixture path must budget for it.
 */
export const FIXTURE_SOCKET_PATH_LIMIT = 100;

/**
 * Compact mkdtemp leaf base (#1841): `abm-<tag>-<base36 ms>-<rand4>`.
 * Replaces the 26-char `e2e-<ms>-<rand8>` run IDs that pushed fixture socket
 * paths past the macOS limit. mkdtemp appends 6 more chars; uniqueness comes
 * from millisecond time plus randomness in both segments.
 */
export function fixtureDirStem(tag: string): string {
  return `abm-${tag}-${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
}

/**
 * Fail fast with an actionable message instead of a cryptic daemon
 * `listen EINVAL` plus a misleading readiness timeout (#1841).
 */
export function assertFixtureSocketPath(socketPath: string): void {
  if (socketPath.length > FIXTURE_SOCKET_PATH_LIMIT) {
    throw new Error(
      `Fixture socket path exceeds ${FIXTURE_SOCKET_PATH_LIMIT} chars (${socketPath.length}): ${socketPath} — ` +
      `shorten TMPDIR or the fixture prefix (macOS sun_path limit 104)`,
    );
  }
}
