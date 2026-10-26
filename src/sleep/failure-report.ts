/**
 * failure-report.ts — bounded sleep failure mapping (#1838 Part 1).
 *
 * Verbatim move from src/sleep/orchestrator.ts (lines 102-199 @ 927deb7).
 * No logic touched.
 */

import { redactSecrets } from "../redact-secrets.js";
import { isSleepModelFailure } from "./llm-budget.js";
import type { ExecutionEffects, ExecutionFailureClass, SleepFailure, SleepFailureCause } from "./contracts.js";

const SLEEP_FAILURE_CAUSES: ReadonlySet<string> = new Set([
  "provider_failed","provider_timeout","step_deadline","invalid_response",
  "prompt_round_limit","candidate_round_limit","candidate_exhausted","policy_rejected",
  "nonzero_exit","spawn_error","timeout","aborted","shell_syntax_error","repeated_failure",
  "memory_validation","memory_not_found","memory_conflict","memory_unauthorized",
  "memory_idempotency_conflict","memory_unavailable","memory_outcome_unknown",
  "completion_settlement_failed","service_failed","unknown"
]);

const FAILURE_CLASSES: ReadonlySet<string> = new Set(["transient", "permanent", "cancelled", "unavailable", "unknown"]);
const EFFECTS: ReadonlySet<string> = new Set(["absent", "reconcilable", "unknown"]);

/** #1912: preserve validated normalized execution facts across failure
 *  wrapping — evidence must survive to reports, never be erased by a blanket
 *  provider_failed/unknown mapping. */
function preserveFacts(into: SleepFailure, from: SleepFailure | undefined): void {
  if (!from) return;
  if (typeof from.failureClass === "string" && FAILURE_CLASSES.has(from.failureClass)) {
    into.failureClass = from.failureClass as ExecutionFailureClass;
  }
  if (typeof from.retryAfterMs === "number" && Number.isSafeInteger(from.retryAfterMs) && from.retryAfterMs > 0) {
    into.retryAfterMs = Math.min(from.retryAfterMs, 3_600_000);
  }
  if (typeof from.reachedModel === "boolean") into.reachedModel = from.reachedModel;
  if (typeof from.effects === "string" && EFFECTS.has(from.effects)) {
    into.effects = from.effects as ExecutionEffects;
  }
  if (typeof from.reasonCode === "string" && from.reasonCode.length > 0) {
    into.reasonCode = from.reasonCode.slice(0, 80);
  }
}

export function toBoundedFailure(cause: string, detail?: string, fingerprint?: string): SleepFailure {
  const normalized = SLEEP_FAILURE_CAUSES.has(cause) ? cause as SleepFailureCause : "unknown";
  const bounded: SleepFailure = { cause: normalized };
  if (detail) {
    const redacted = redactSecrets(String(detail)).slice(0, 240);
    if (redacted) bounded.detail = redacted;
  }
  if (fingerprint && /^[0-9a-f]{16}$/i.test(fingerprint)) bounded.commandFingerprint = fingerprint;
  return bounded;
}

export function failureFromError(err: unknown, fallbackCause: SleepFailureCause = "unknown"): SleepFailure {
  if (err && typeof err === "object" && "failure" in (err as Record<string, unknown>)) {
    const f = (err as { failure?: SleepFailure }).failure;
    if (f?.cause) {
      const out = toBoundedFailure(f.cause, f.detail, f.commandFingerprint);
      preserveFacts(out, f);
      return out;
    }
  }
  if (isSleepModelFailure(err)) {
    const f = (err as { failure?: SleepFailure }).failure;
    if (f?.cause) {
      const out = toBoundedFailure(f.cause, f.detail ?? err.message, f.commandFingerprint);
      preserveFacts(out, f);
      return out;
    }
    // Map broad reason to cause when no specific failure present
    const map: Record<string, SleepFailureCause> = {
      provider_failed: "provider_failed",
      provider_timeout: "provider_timeout",
      step_deadline: "step_deadline",
      invalid_response: "invalid_response",
    };
    const cause = map[err.reason] ?? fallbackCause;
    return toBoundedFailure(cause, err.message);
  }
  const msg = err instanceof Error ? err.message : String(err);
  // Heuristic for policy/tool failures wrapped as generic errors
  if (/policy_rejected/i.test(msg)) return toBoundedFailure("policy_rejected", msg);
  if (/shell_syntax_error/i.test(msg)) return toBoundedFailure("shell_syntax_error", msg);
  if (/timeout/i.test(msg)) return toBoundedFailure("timeout", msg);
  return toBoundedFailure(fallbackCause, msg);
}

export function actionForCause(cause: SleepFailureCause): string {
  switch (cause) {
    case "prompt_round_limit":
    case "candidate_round_limit":
    case "candidate_exhausted":
      return "Review the provider/model or loop; keep the safety limit unchanged, then retry.";
    case "policy_rejected":
      return "Review the sleep command policy; sleep does not wait for Telegram authorization.";
    case "nonzero_exit":
    case "spawn_error":
    case "timeout":
    case "aborted":
    case "shell_syntax_error":
    case "repeated_failure":
      return "Review the named tool failure and command fingerprint, then retry.";
    case "provider_timeout":
    case "provider_failed":
      return "Check provider/transport availability, then retry.";
    case "step_deadline":
      return "Retry after checking provider latency or step deadline configuration.";
    case "invalid_response":
      return "Check the configured model's response format, then retry.";
    case "memory_validation":
    case "memory_not_found":
    case "memory_conflict":
    case "memory_unauthorized":
    case "memory_idempotency_conflict":
    case "memory_unavailable":
    case "memory_outcome_unknown":
      return "Check the memory backend and the named memory error, then retry.";
    case "completion_settlement_failed":
      return "Check the runtime broker/lease state, then retry.";
    case "service_failed":
    case "unknown":
    default:
      return "Check daemon/service availability, then retry.";
  }
}

export function detailForCause(cause: SleepFailureCause): string {
  switch (cause) {
    case "prompt_round_limit": return "hard 25 prompt rounds reached";
    case "candidate_round_limit": return "candidate round limit reached";
    case "candidate_exhausted": return "no eligible candidate";
    case "policy_rejected": return "command blocked by policy";
    case "step_deadline": return "logical step deadline exceeded";
    case "invalid_response": return "model returned empty/invalid responses";
    case "provider_timeout": return "provider timed out";
    case "provider_failed": return "provider failed";
    default: return cause;
  }
}
