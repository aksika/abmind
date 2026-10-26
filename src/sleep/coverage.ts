/**
 * sleep/coverage.ts — coverage-proven settlement ledger (#1860).
 *
 * A claim is evidence that a message-consuming step read a timestamp range,
 * scoped to the principal and session scope it read under. The extraction
 * watermark is a derived effect of this ledger, never a second source of
 * truth. No `memory.db` change: claims persist as optional `StepResult`
 * data in the sleep state file, validated by the existing parser.
 *
 * Dispositions: `covered` (read and reflected in output), `excluded`
 * (deliberately not sleep input, with a reason), `unclaimed` (a skipped
 * range sleep was asked to process). A range with no claim entry at all
 * (legacy state files) is unclaimed by definition — never covered.
 */

import type { SleepState } from "./state.js";

// ── Claim shape ─────────────────────────────────────────────────────────────

export type CoverageDisposition = "covered" | "excluded" | "unclaimed";

/** Session scope a claim was read under. "A"/"C" mirror the sleep session
 *  filter (`sleep-daily-summary.ts`); "excluded" marks deliberate
 *  non-input (garbage marks, `[SYSTEM` prefix). */
export type CoverageScope = "A" | "C" | "excluded";

export interface CoverageClaim {
  /** Principal whose messages were read (the run's primary user id). */
  principal: string;
  scope: CoverageScope;
  /** Inclusive message-timestamp bounds of the claimed range. */
  startTs: number;
  endTs: number;
  disposition: CoverageDisposition;
  /** Required for `excluded`: why the range is not sleep input. */
  reason?: string;
}

/** Timestamp interval produced by the daily-summary build. */
export interface CoverageInterval {
  startTs: number;
  endTs: number;
}

/** Interval attributed to one consumed session scope. */
export interface ScopedInterval extends CoverageInterval {
  scope: "A" | "C";
}

export interface ExcludedInterval extends CoverageInterval {
  reason: string;
}

// ── Session-scope classification ────────────────────────────────────────────
// Mirrors the SQL session filter in `sleep-daily-summary.ts` (main = A +
// empty/pre-migration, code = C). A message matches exactly one class: a
// session id containing both `_A_` and `_C_` is attributed to A.

/** SQL fragment matching every session scope sleep consumes (A, C, empty,
 *  pre-migration without an `_X_` pattern). */
export const CONSUMED_SESSION_SQL =
  "(session_id LIKE '%\\_A\\_%' ESCAPE '\\' OR session_id LIKE '%\\_C\\_%' ESCAPE '\\' OR session_id = '' OR session_id NOT LIKE '%\\_%\\_%' ESCAPE '\\')";

export function isConsumedSleepSession(sessionId: string | null | undefined): boolean {
  const s = sessionId ?? "";
  if (s === "") return true;
  if (s.includes("_A_") || s.includes("_C_")) return true;
  // Pre-migration ids carry no `_X_` pattern: fewer than two underscores.
  let underscores = 0;
  for (const ch of s) {
    if (ch === "_") underscores++;
  }
  return underscores < 2;
}

/** Scope class of one consumed message for claim attribution. */
export function scopeOfSession(sessionId: string | null | undefined): "A" | "C" {
  const s = sessionId ?? "";
  if (s.includes("_C_") && !s.includes("_A_")) return "C";
  return "A";
}

// ── Parser (lenient, fail-safe toward retention) ────────────────────────────
// A malformed claim field is treated as absent — the range stays unclaimed
// and holds the watermark — rather than invalidating the whole state file
// (which would silently drop the lock from next-run recovery).

function isFiniteTs(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function parseOneClaim(raw: unknown): CoverageClaim | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["principal"] !== "string" || r["principal"] === "" || r["principal"].length > 128) return null;
  if (r["scope"] !== "A" && r["scope"] !== "C" && r["scope"] !== "excluded") return null;
  if (!isFiniteTs(r["startTs"]) || !isFiniteTs(r["endTs"])) return null;
  if ((r["startTs"] as number) > (r["endTs"] as number)) return null;
  if (r["disposition"] !== "covered" && r["disposition"] !== "excluded" && r["disposition"] !== "unclaimed") return null;
  if (r["disposition"] === "excluded") {
    if (typeof r["reason"] !== "string" || r["reason"] === "" || r["reason"].length > 128) return null;
  } else if (r["reason"] !== undefined && typeof r["reason"] !== "string") return null;
  return {
    principal: r["principal"] as string,
    scope: r["scope"] as CoverageScope,
    startTs: r["startTs"] as number,
    endTs: r["endTs"] as number,
    disposition: r["disposition"] as CoverageDisposition,
    ...(typeof r["reason"] === "string" ? { reason: r["reason"] } : {}),
  };
}

/** Validate the optional `claims` field of a step. Absent (legacy) stays
 *  absent — the caller treats it as unclaimed. Malformed entries are
 *  dropped; a non-array field is dropped whole. Never throws. */
export function parseCoverageClaims(raw: unknown): CoverageClaim[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const claims: CoverageClaim[] = [];
  for (const entry of raw) {
    const claim = parseOneClaim(entry);
    // A partial ledger cannot prove that omitted entries were covered. Treat
    // the whole field as unknown so settlement holds and the next run re-covers it.
    if (!claim) return undefined;
    claims.push(claim);
  }
  return claims;
}

// ── Ledger queries ──────────────────────────────────────────────────────────

/** Every claim in the run, across all steps. */
export function allClaims(state: SleepState): CoverageClaim[] {
  const out: CoverageClaim[] = [];
  for (const step of Object.values(state.steps)) {
    if (step.claims) out.push(...step.claims);
  }
  return out;
}

/** Unclaimed ranges for one principal: explicit `unclaimed` claims. A state
 *  file with no claim data at all (legacy) is unclaimed by definition but
 *  has unknown bounds — settlement holds its watermark so the next run
 *  re-covers it. */
export function unclaimedRanges(state: SleepState, principal?: string): CoverageInterval[] {
  return allClaims(state)
    .filter(c => c.disposition === "unclaimed" && (principal === undefined || c.principal === principal))
    .map(c => ({ startTs: c.startTs, endTs: c.endTs }));
}

export function hasUnclaimedRanges(state: SleepState, principal?: string): boolean {
  if (unclaimedRanges(state, principal).length > 0) return true;
  const daily = state.steps["daily-summary"];
  // Legacy and malformed state has no range bounds to report, but it is still
  // unclaimed. A deliberate no-work skip is the only state that needs no
  // claim. Keep every other unknown range recoverable.
  return daily?.status !== "skipped" && (daily === undefined || daily.claims === undefined || daily.claims.length === 0);
}

/**
 * Coverage ceiling for one principal: the greatest timestamp `T` such that
 * every consumed-scope message at or below `T` is claimed. The first
 * unclaimed message is the ceiling — the watermark lands immediately below
 * it. Returns null when no advance is authorized (no claim data, or the
 * daily step did not produce claims).
 */
export function coverageCeilingTs(state: SleepState, principal: string, targetTs: number): number | null {
  const daily = state.steps["daily-summary"];
  if (!daily || daily.status !== "ok" || daily.claims === undefined) return null;
  const principalClaims = daily.claims.filter(claim => claim.principal === principal);
  if (principalClaims.length === 0) return null;
  let ceiling = targetTs;
  for (const claim of principalClaims) {
    if (claim.disposition !== "unclaimed") continue;
    if (claim.startTs > targetTs) continue;
    // Watermark must stay below the first message of the hole.
    ceiling = Math.min(ceiling, claim.startTs - 1);
  }
  return ceiling;
}

/** Merge timestamp intervals per reason into coarse visibility markers.
 *  These are audit markers only — flush-time enforcement lives in the
 *  prune SQL, so a coarse span never authorizes deletion by itself. */
export function mergeExcluded(intervals: Array<CoverageInterval & { reason: string }>): ExcludedInterval[] {
  const byReason = new Map<string, { startTs: number; endTs: number }>();
  for (const iv of intervals) {
    const cur = byReason.get(iv.reason);
    if (!cur) byReason.set(iv.reason, { startTs: iv.startTs, endTs: iv.endTs });
    else {
      cur.startTs = Math.min(cur.startTs, iv.startTs);
      cur.endTs = Math.max(cur.endTs, iv.endTs);
    }
  }
  return [...byReason.entries()].map(([reason, span]) => ({ ...span, reason }));
}

/** One-line human rendering of timestamp ranges for logs, audit, and the
 *  run report. */
export function formatRanges(ranges: CoverageInterval[]): string {
  return ranges
    .map(r => `${new Date(r.startTs).toISOString()}..${new Date(r.endTs).toISOString()}`)
    .join(", ");
}
