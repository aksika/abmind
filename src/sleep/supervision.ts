/**
 * sleep/supervision.ts — deterministic step supervision policy (#1912).
 *
 * The supervisor makes no model call. Given normalized execution evidence it
 * decides, in code, whether a failed work item receives another bounded
 * attempt or terminates truthfully with a recorded blocker.
 *
 * A work item is one model-reaching send (a batched subcall or a single
 * corrective send). It owns at most MAX_SUPERVISED_ATTEMPTS total attempts
 * including its initial attempt — transport-transient retries and
 * empty/invalid-response retries share that one allowance, never nested
 * ladders. Natural progress to a different batch is new work, not a repeat.
 *
 * Side-effect safety: sleep completion calls return proposal text; durable
 * writes happen only through validated revision-checked apply paths with
 * content-addressed operation identities, so re-issuing a completion after an
 * unknown outcome cannot duplicate a write — reconciliation happens at apply
 * time via already-accepted receipts, not by refusing the retry.
 */

import { SLEEP_PROVIDER_CLEANUP_HEADROOM_MS } from "./step-deadlines.js";
import type {
  ExecutionFailureClass,
  NormalizedExecutionFacts,
  SleepFailure,
} from "./contracts.js";

/** Four total attempts per work item, including its initial attempt. */
export const MAX_SUPERVISED_ATTEMPTS = 4;

/** Transient waits before attempts 2, 3, and 4. Corrections for
 *  invalid/missing domain output proceed without a provider cooldown. */
export const SUPERVISION_WAITS_MS: readonly [number, number, number] = [20_000, 60_000, 300_000];

/** Minimum useful window for one more provider attempt after a wait. */
const MIN_ATTEMPT_WINDOW_MS = 30_000;

export type SupervisionDecision =
  | { action: "retry"; waitMs: number; reason: string }
  | { action: "suspend"; detail: string }
  | { action: "stop"; disposition: "blocker" | "cancelled" | "exhausted"; detail: string };

function boundedReasonCode(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const code = raw.slice(0, 80).trim();
  return code ? code : undefined;
}

function positiveMs(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.min(Math.floor(raw), 3_600_000);
}

/**
 * Normalize host/broker execution evidence into a failure class. Hosts
 * supply structured facts when they have them; otherwise classification
 * falls back to deterministic interpretation of the cause, admission code,
 * and message. An arbitrary provider error or unsupported model explanation
 * is never proof of a justified blocker — unknown stays retryable.
 */
export function classifyExecutionFailure(input: {
  failure?: SleepFailure;
  admissionCode?: string;
  message?: string;
}): NormalizedExecutionFacts {
  const failure = input.failure;
  if (failure?.failureClass !== undefined
    && (failure.failureClass === "transient" || failure.failureClass === "permanent"
      || failure.failureClass === "cancelled" || failure.failureClass === "unavailable"
      || failure.failureClass === "unknown")) {
    return {
      failureClass: failure.failureClass,
      ...(positiveMs(failure.retryAfterMs) !== undefined ? { retryAfterMs: positiveMs(failure.retryAfterMs) } : {}),
      ...(typeof failure.reachedModel === "boolean" ? { reachedModel: failure.reachedModel } : {}),
      ...(failure.effects === "absent" || failure.effects === "reconcilable" || failure.effects === "unknown"
        ? { effects: failure.effects } : {}),
      ...(boundedReasonCode(failure.reasonCode) !== undefined ? { reasonCode: boundedReasonCode(failure.reasonCode) } : {}),
    };
  }

  // The cause alone never classifies transient: a collapsed legacy
  // provider_failed with no detail is unknown, never implicit replay
  // permission. Concrete evidence lives in detail/message/reasonCode.
  const msg = `${input.message ?? ""} ${failure?.detail ?? ""}`.toLowerCase();
  const admission = input.admissionCode ?? "";
  const reasonCode = boundedReasonCode(failure?.reasonCode);

  const has = (...needles: string[]): boolean => needles.some(n => msg.includes(n));

  // Cancellation is explicit — never retried, never relabeled.
  if (failure?.cause === "aborted" || admission === "cancelled"
    || has("cancelled", "abort", "sleep cancelled", "cycle timeout", "sleep cycle timeout")) {
    return { failureClass: "cancelled", ...(reasonCode ? { reasonCode } : {}) };
  }
  // No executable provider holds the lease — ends promptly, without waits.
  if (admission === "provider_unavailable" || admission === "completion_pending"
    || admission === "capability_mismatch" || failure?.cause === "completion_settlement_failed") {
    return { failureClass: "unavailable", ...(reasonCode ? { reasonCode } : {}), reachedModel: false };
  }
  // Credits/auth/policy blockers stop with their actual reason, no waits.
  if (failure?.cause === "policy_rejected"
    || has("401", "unauthorized", "unauthenticated", "forbidden", "403",
      "credit", "billing", "quota", "insufficient", "payment",
      "policy_rejected", "capability_mismatch", "permission denied")) {
    return { failureClass: "permanent", ...(reasonCode ? { reasonCode } : {}), reachedModel: false };
  }
  // Transient provider/transport states — bounded recovery is justified.
  if (has("429", "rate limit", "ratelimit", "retry", "503", "502", "504", "overload",
    "temporarily", "try again", "econnreset", "etimedout", "econnrefused", "enotfound",
    "connection refused", "connection reset", "refused", "reset by peer",
    "network", "socket hang up", "timeout", "timed out", "deadline", "provider_failed")) {
    return {
      failureClass: "transient",
      ...(positiveMs(failure?.retryAfterMs) !== undefined ? { retryAfterMs: positiveMs(failure?.retryAfterMs) } : {}),
      ...(typeof failure?.reachedModel === "boolean" ? { reachedModel: failure.reachedModel } : {}),
      ...(reasonCode ? { reasonCode } : {}),
    };
  }
  // No new evidence from an older host is unknown — retryable within the
  // allowance, never implicit permission to replay beyond it.
  return {
    failureClass: "unknown",
    effects: "unknown",
    ...(reasonCode ? { reasonCode } : {}),
  };
}

/** Whether a thrown transport error was a broker admission refusal — those
 *  never reached the model and must not consume budget. */
export function isAdmissionRefusal(err: unknown): boolean {
  const code = (err as { providerCode?: unknown })?.providerCode
    ?? (err as { code?: unknown })?.code;
  return code === "provider_unavailable" || code === "completion_pending" || code === "capability_mismatch";
}

/**
 * Decide the next action for a failed attempt. `attemptsUsed` counts
 * model-reaching calls for this work item (1-based: 1 after the initial
 * attempt failed). Pure function of evidence and remaining allowances —
 * the cycle timer never restarts and waits never extend it.
 */
export function decideRecovery(input: {
  facts: NormalizedExecutionFacts;
  attemptsUsed: number;
  maxAttempts?: number;
  nowMs: number;
  /** Absolute cap for useful work: the per-attempt window ceiling already
   *  capped by the remaining cycle deadline and cleanup headroom. */
  capAtMs: number;
}): SupervisionDecision {
  const maxAttempts = input.maxAttempts ?? MAX_SUPERVISED_ATTEMPTS;
  const { facts, attemptsUsed, nowMs, capAtMs } = input;
  const detailSuffix = facts.reasonCode ? ` (${facts.reasonCode})` : "";

  if (facts.failureClass === "cancelled") {
    return { action: "stop", disposition: "cancelled", detail: `cancelled${detailSuffix}` };
  }
  if (facts.failureClass === "permanent") {
    return { action: "stop", disposition: "blocker", detail: `permanent blocker${detailSuffix} — no futile retries` };
  }
  if (facts.failureClass === "unavailable") {
    return { action: "stop", disposition: "blocker", detail: `no executable provider${detailSuffix} — ending promptly` };
  }
  if (attemptsUsed >= maxAttempts) {
    return {
      action: "stop",
      disposition: "exhausted",
      detail: `allowance exhausted after ${attemptsUsed} attempt(s)${detailSuffix} — recorded once, never success`,
    };
  }

  // A longer normalized retry-after hint wins when it fits the remaining
  // budget; otherwise the scheduled transient wait applies. Corrections for
  // invalid/missing domain output never reach this path (they wait 0).
  const scheduled = SUPERVISION_WAITS_MS[Math.min(attemptsUsed - 1, SUPERVISION_WAITS_MS.length - 1)] ?? 0;
  const hinted = facts.retryAfterMs !== undefined && facts.retryAfterMs > scheduled ? facts.retryAfterMs : scheduled;
  const fits = (waitMs: number): boolean =>
    nowMs + waitMs + SLEEP_PROVIDER_CLEANUP_HEADROOM_MS + MIN_ATTEMPT_WINDOW_MS <= capAtMs;
  if (fits(hinted)) {
    return {
      action: "retry",
      waitMs: hinted,
      reason: facts.retryAfterMs !== undefined && facts.retryAfterMs > scheduled
        ? `retry-after ${facts.retryAfterMs}ms fits remaining budget`
        : `transient failure, attempt ${attemptsUsed + 1}/${maxAttempts}`,
    };
  }
  if (hinted !== scheduled && fits(scheduled)) {
    return { action: "retry", waitMs: scheduled, reason: `retry-after exceeds remaining budget — scheduled wait applies` };
  }
  // No time for another useful attempt: suspend for resume, not failure.
  return { action: "suspend", detail: `no remaining cycle budget for attempt ${attemptsUsed + 1}/${maxAttempts}${detailSuffix}` };
}

/** Attach normalized facts to a SleepFailure without disturbing its cause,
 *  detail, or fingerprint. Additive — legacy readers ignore the fields. */
export function withExecutionFacts(failure: SleepFailure, facts: NormalizedExecutionFacts): SleepFailure {
  return {
    ...failure,
    failureClass: facts.failureClass satisfies ExecutionFailureClass,
    ...(facts.retryAfterMs !== undefined ? { retryAfterMs: facts.retryAfterMs } : {}),
    ...(facts.reachedModel !== undefined ? { reachedModel: facts.reachedModel } : {}),
    ...(facts.effects !== undefined ? { effects: facts.effects } : {}),
    ...(facts.reasonCode !== undefined ? { reasonCode: facts.reasonCode } : {}),
  };
}
