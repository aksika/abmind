/**
 * sleep/llm-budget.ts — LLM call budget tracking and bounded domain retry.
 *
 * #1353: transport retry/backoff is a host responsibility, not abmind's.
 * `SleepRuntime.complete()` is one host-supervised model operation — if it
 * rejects, the host has already exhausted its own provider policy. Abmind
 * records a transport-unavailable step outcome and follows its
 * essential-step stop/suspend rules; it does not sleep and retry the provider
 * itself.
 *
 * The bounded retry that remains here is a DOMAIN retry: a structurally
 * empty or invalid *successful* response is retried a small number of times
 * because another model call is semantically meaningful (the model may
 * simply produce a better answer next time). Every model-reaching attempt —
 * retried or not — is charged to the LLM budget.
 *
 * #1676: every attempt (first call and domain retries) runs under one window
 * derived once at `sendToRuntime()` entry (`deadlineAt - clockNow()`). The
 * attempt deadline is refreshed onto each attempt start, so a long-delayed
 * retry still gets a full window — the clock restarts per attempt rather than
 * running once from the logical step start. Exhaustion of an attempt deadline,
 * a provider rejection/timeout, or exhaustion of valid-output retries raises
 * the typed terminal SleepModelFailureError — the orchestrator stops the
 * sleep, never the next step.
 */

import { getAbmindEnv } from "../env-schema.js";
import { logWarn, logError, logTrace } from "../mem-logger.js";
import { redactSecrets } from "../redact-secrets.js";
import { LLMUnavailableError } from "../sleep-pipeline.js";
import type { SleepRuntime, SleepCompletionRequest, SleepCompletionResult, ContentOutcome } from "./contracts.js";
import { writeStateFile } from "./state.js";
import type { SleepState } from "./state.js";
import { SleepCompletionDeadlineError, RuntimeCompletionAdmissionError } from "../sleep-service/runtime-broker.js";
import { SLEEP_PROVIDER_CLEANUP_HEADROOM_MS } from "./step-deadlines.js";

const TAG = "abmind-sleep";

/** Bounded retries for an empty/invalid domain response. Not a transport retry. */
export const MAX_DOMAIN_RETRIES = 4;

/** Delay (ms) before each bounded domain retry of an empty/invalid successful
 *  response. Index i is the wait before the (i+2)-th attempt; the final entry
 *  applies to any further retry. Default: 30s between attempts 1→2, then 15m
 *  before each subsequent attempt so a transient provider degradation can clear.
 *  #1676: every attempt re-bases budgetWindowMs onto its own start, so retry
 *  delays do NOT consume the step's window — each attempt gets a fresh full
 *  window (long delays therefore never become step_deadline; see llm-budget.ts).
 *  Not a transport retry — transport backoff belongs to the host (#1353). */
export const DEFAULT_RETRY_DELAYS: readonly [number, number, number] = [30_000, 900_000, 900_000];

/** Await a retry delay while observing the caller's signal. Resolves `true`
 *  when the delay completed, `false` if the signal aborted mid-wait. Installs
 *  exactly one timer and one one-shot abort listener and clears both on every
 *  path, so no timer/listener survives cancellation or the normal completion. */
function waitForRetryDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (delayMs <= 0) return Promise.resolve(!signal.aborted);
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer) clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
  });
}

/** Per-attempt evidence for empty/invalid domain responses — #1752 R10. Bounded and redacted. */
export interface EmptyAttemptEvidence {
  attempt: number;
  responseLength: number;
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  hasReasoning?: boolean;
  hasToolCalls?: boolean;
  outcome?: ContentOutcome;
}

function normalizeCompletionResult(raw: string | SleepCompletionResult): { text: string; evidence: Partial<EmptyAttemptEvidence> } {
  if (typeof raw === "string") return { text: raw, evidence: {} };
  const text = typeof raw.text === "string" ? raw.text : "";
  const evidence: Partial<EmptyAttemptEvidence> = {};
  if (raw.outcome) evidence.outcome = raw.outcome as ContentOutcome;
  if (raw.finishReason) evidence.finishReason = String(raw.finishReason).slice(0, 80);
  if (typeof raw.promptTokens === "number") evidence.promptTokens = raw.promptTokens;
  if (typeof raw.completionTokens === "number") evidence.completionTokens = raw.completionTokens;
  if (typeof raw.hasReasoning === "boolean") evidence.hasReasoning = raw.hasReasoning;
  if (typeof raw.hasToolCalls === "boolean") evidence.hasToolCalls = raw.hasToolCalls;
  return { text, evidence };
}

/** Stable terminal model-failure reasons surfaced in the cycle report (#1611). */
export type SleepModelFailureReason =
  | "provider_failed"
  | "provider_timeout"
  | "step_deadline"
  | "invalid_response";

/**
 * Terminal model-step failure. Thrown by sendToRuntime; the orchestrator stops
 * the sleep on it, marks the current step timeout/failed, advances no
 * watermark, and returns a resumable failed result. Extends
 * LLMUnavailableError so buildDailySummary/extractFromDaily propagate it
 * naturally (they check instanceof LLMUnavailableError to bubble errors up).
 */
export class SleepModelFailureError extends LLMUnavailableError {
  readonly reason: SleepModelFailureReason;
  readonly stepId: string;
  readonly failure?: import("./contracts.js").SleepFailure;
  readonly evidence?: EmptyAttemptEvidence[];

  constructor(stepId: string, reason: SleepModelFailureReason, message: string, failure?: import("./contracts.js").SleepFailure, evidence?: EmptyAttemptEvidence[]) {
    super(message);
    this.name = "SleepModelFailureError";
    this.reason = reason;
    this.stepId = stepId;
    if (failure) this.failure = failure;
    if (evidence) this.evidence = evidence;
  }
}

/** Narrowing helper for catch sites. */
export function isSleepModelFailure(err: unknown): err is SleepModelFailureError {
  return err instanceof SleepModelFailureError;
}

/** Thrown when the host's `runtime.complete()` rejects — a transport failure,
 *  not a domain one. Mapped to the stable `provider_failed` reason. */
export class TransportUnavailableError extends SleepModelFailureError {
  /** #1681: the broker's stable admission code (provider_unavailable |
   *  completion_pending) when the rejection was an admission refusal. The code
   *  survives wrapping and appears in the failure message. */
  readonly providerCode?: string;
  constructor(stepId: string, cause?: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    // #1681: preserve the broker's machine-readable admission code through the
    // transport wrapper — the report needs the exact refusal reason.
    const providerCode = cause instanceof RuntimeCompletionAdmissionError ? cause.code : undefined;
    const msg = causeMsg;
    // #1611: a host-supplied stable timeout code survives the mapping so the
    // report can distinguish provider_timeout from a generic provider_failed.
    const reason: SleepModelFailureReason = msg.includes("provider_timeout") ? "provider_timeout" : "provider_failed";
    // Preserve structured failure if the cause carries one (broker typed error)
    const failure = (cause as { failure?: import("./contracts.js").SleepFailure } | null)?.failure
      ?? (cause instanceof SleepModelFailureError ? cause.failure : undefined);
    super(stepId, reason, `Runtime rejected for step "${stepId}": ${msg}`, failure);
    this.name = "TransportUnavailableError";
    if (providerCode) this.providerCode = providerCode;
    if (failure && !this.failure) (this as { failure?: import("./contracts.js").SleepFailure }).failure = failure;
  }
}

/** Budget tracker — shared across all completion calls in a sleep cycle. */
export class LlmBudget {
  private state: SleepState;
  private readonly statePath: string;
  /** #1653: run-local per-step attribution for this execution attempt only.
   *  Catch-up calls keep their distinct `catch-up-*` ids — the current run's
   *  reviewer never mistakes them for the current day's similarly named step. */
  private readonly callsByStep = new Map<string, number>();
  exhausted = false;

  constructor(state: SleepState, statePath: string) {
    this.state = state;
    this.statePath = statePath;
  }

  /** Increment counter, return false if budget exhausted. The logical `stepId`
   *  records which step reached the model — the durable run-level total in
   *  `state.llmCalls` keeps its existing meaning (#1653). */
  consume(stepId: string): boolean {
    this.callsByStep.set(stepId, (this.callsByStep.get(stepId) ?? 0) + 1);
    this.state.llmCalls = (this.state.llmCalls ?? 0) + 1;
    writeStateFile(this.statePath, this.state);
    if (this.state.llmCalls > getAbmindEnv().sleepMaxLlmCalls) {
      this.exhausted = true;
      return false;
    }
    return true;
  }

  /** #1653: model-reaching attempts charged to one logical step in THIS
   *  execution attempt. Empty across resume boundaries — the map starts fresh
   *  for each `LlmBudget` instance. */
  callsFor(stepId: string): number {
    return this.callsByStep.get(stepId) ?? 0;
  }

  get calls(): number { return this.state.llmCalls ?? 0; }
}

/**
 * Send one prompt through the host runtime with bounded domain retry for
 * empty/invalid responses. One attempt window is derived once from the
 * incoming `deadlineAt` and re-based onto each attempt start.
 *
 * - A runtime rejection is NOT retried here — it propagates immediately as a
 *   typed SleepModelFailureError (provider_failed / provider_timeout).
 * - The broker's own deadline error maps to `step_deadline`.
 * - Exhaustion of MAX_DOMAIN_RETRIES empty responses maps to `invalid_response`.
 * - Each attempt receives the same window (`budgetWindowMs`) measured at
 *   entry, refreshed onto the attempt start. A retry delayed past the caller's
 *   original timestamp still runs under a full window; only a window at or
 *   below the cleanup headroom is refused (`step_deadline`).
 *
 * Returns null ONLY when the budget is already exhausted (call not made), the
 * caller's signal aborted (cancellation, including mid-delay), or the retry
 * wait was cancelled — the orchestrator's own suspend/cancel paths.
 */
export async function sendToRuntime(
  runtime: SleepRuntime,
  prompt: string,
  stepId: string,
  runId: string,
  signal: AbortSignal,
  deadlineAt: number,
  budget?: LlmBudget,
  retryDelays: readonly number[] = DEFAULT_RETRY_DELAYS,
  clockNow: () => number = Date.now,
): Promise<string | null> {
  if (budget?.exhausted) {
    logWarn(TAG, `[BUDGET] LLM call limit (${getAbmindEnv().sleepMaxLlmCalls}) reached at step ${stepId} — suspending`);
    return null;
  }

  // #1676: one window for every attempt — derived once from the caller's
  // logical-step deadline, then re-based onto each attempt start. The timer
  // starts when the attempt begins (i.e. after the previous invocation and its
  // retry delay completed), never from the step start.
  const budgetWindowMs = deadlineAt - clockNow();

  let emptyAttempts = 0;
  const attemptEvidence: EmptyAttemptEvidence[] = [];
  while (true) {
    if (signal.aborted) return null;

    // Refresh the attempt deadline before the headroom gate and the request:
    // a retry never inherits a stale absolute timestamp from the step start.
    const attemptStartedAt = clockNow();
    deadlineAt = attemptStartedAt + budgetWindowMs;

    // #1611/#1676: refuse to start a call/retry once cleanup headroom has
    // begun. Evaluated against the refreshed per-attempt window — elapsed time
    // before a retry no longer fails a retry solely because the old absolute
    // timestamp passed.
    const remaining = deadlineAt - attemptStartedAt;
    if (remaining <= SLEEP_PROVIDER_CLEANUP_HEADROOM_MS) {
      throw new SleepModelFailureError(
        stepId,
        "step_deadline",
        `Logical step ${stepId} attempt window (${Math.max(0, remaining)}ms) at or below the cleanup headroom — not starting another provider call`,
        { cause: "step_deadline", detail: `window ${Math.max(0, remaining)}ms at or below headroom` },
      );
    }

    const request: SleepCompletionRequest = { prompt, stepId, runId, signal, deadlineAt };
    let rawResult: string | SleepCompletionResult;
    try {
      rawResult = await runtime.complete(request);
    } catch (err) {
      if (err instanceof SleepCompletionDeadlineError) {
        // #1611: the broker's completion deadline expired — terminal for the
        // logical step, unlike #1603's continue-the-cycle policy.
        budget?.consume(stepId); // real model time was spent
        throw new SleepModelFailureError(stepId, "step_deadline", `Step ${stepId} exceeded its completion deadline`, { cause: "step_deadline", detail: `completion deadline exceeded for ${stepId}` });
      }
      // Transport failure — model unreachable via the host's own transport.
      // No abmind-side backoff/retry window: the host has already exhausted
      // its provider policy. Surface immediately as a terminal typed error.
      throw new TransportUnavailableError(stepId, err);
    }

    // Real call reached the model — count it now (success OR empty, never a throw).
    if (budget && !budget.consume(stepId)) {
      logWarn(TAG, `[BUDGET] LLM call limit (${getAbmindEnv().sleepMaxLlmCalls}) reached at step ${stepId} — suspending`);
      return null;
    }

    const { text: result, evidence: meta } = normalizeCompletionResult(rawResult);
    const isEmpty = !result || !result.trim();
    if (isEmpty) {
      emptyAttempts++;
      // #1752 R10: bounded per-attempt evidence — no raw prompt, capped detail
      const ev: EmptyAttemptEvidence = {
        attempt: emptyAttempts,
        responseLength: result.length,
        ...meta,
      };
      attemptEvidence.push(ev);
      // At trace, also emit capped redacted text
      logTrace(TAG, `Step ${stepId} empty attempt ${emptyAttempts}: ${JSON.stringify({ attempt: ev.attempt, responseLength: ev.responseLength, outcome: ev.outcome, finishReason: ev.finishReason, hasReasoning: ev.hasReasoning, hasToolCalls: ev.hasToolCalls })} — excerpt: ${redactSecrets(result.slice(0, 200))}`);
      logWarn(TAG, `Step ${stepId} attempt ${emptyAttempts}/${MAX_DOMAIN_RETRIES} returned empty response${ev.outcome ? ` (${ev.outcome})` : ""}`);
      if (emptyAttempts >= MAX_DOMAIN_RETRIES) {
        logError(TAG, `Step ${stepId} failed after ${emptyAttempts} attempts (empty)`);
        // Build detail that includes outcome distinction for R13 when available
        const outcomeDetail = attemptEvidence.map(e => e.outcome ?? "empty").join(",");
        const detail = `empty/invalid responses ${emptyAttempts} times` + (outcomeDetail ? ` (${outcomeDetail})` : "");
        throw new SleepModelFailureError(
          stepId,
          "invalid_response",
          `Step ${stepId} returned empty/invalid responses ${emptyAttempts} times`,
          { cause: "invalid_response", detail },
          [...attemptEvidence],
        );
      }
      if (signal.aborted) return null;
      // Delay before the next attempt: index (emptyAttempts-1), clamped to the
      // final schedule entry. An empty schedule or non-positive entry waits 0.
      const waitMs = retryDelays.length > 0
        ? retryDelays[Math.min(emptyAttempts - 1, retryDelays.length - 1)] ?? 0
        : 0;
      const waited = await waitForRetryDelay(waitMs, signal);
      if (!waited) return null;
      continue;
    }

    return result;
  }
}
