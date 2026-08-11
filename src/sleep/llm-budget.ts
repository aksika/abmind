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
 * #1611: every attempt (first call and domain retries) runs under the ONE
 * absolute deadline of the logical step (`deadlineAt`). A call or retry never
 * restarts the clock and refuses to start once the cleanup headroom has begun.
 * Exhaustion of the deadline, a provider rejection/timeout, or exhaustion of
 * valid-output retries raises the typed terminal SleepModelFailureError — the
 * orchestrator stops the sleep, never the next step.
 */

import { getAbmindEnv } from "../env-schema.js";
import { logWarn, logError } from "../mem-logger.js";
import { LLMUnavailableError } from "../sleep-pipeline.js";
import type { SleepRuntime, SleepCompletionRequest } from "./contracts.js";
import { writeStateFile } from "./state.js";
import type { SleepState } from "./state.js";
import { SleepCompletionDeadlineError } from "../sleep-service/runtime-broker.js";
import { SLEEP_PROVIDER_CLEANUP_HEADROOM_MS } from "./step-deadlines.js";

const TAG = "abmind-sleep";

/** Bounded retries for an empty/invalid domain response. Not a transport retry. */
export const MAX_DOMAIN_RETRIES = 3;

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

  constructor(stepId: string, reason: SleepModelFailureReason, message: string) {
    super(message);
    this.name = "SleepModelFailureError";
    this.reason = reason;
    this.stepId = stepId;
  }
}

/** Narrowing helper for catch sites. */
export function isSleepModelFailure(err: unknown): err is SleepModelFailureError {
  return err instanceof SleepModelFailureError;
}

/** Thrown when the host's `runtime.complete()` rejects — a transport failure,
 *  not a domain one. Mapped to the stable `provider_failed` reason. */
export class TransportUnavailableError extends SleepModelFailureError {
  constructor(stepId: string, cause?: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    // #1611: a host-supplied stable timeout code survives the mapping so the
    // report can distinguish provider_timeout from a generic provider_failed.
    const reason: SleepModelFailureReason = msg.includes("provider_timeout") ? "provider_timeout" : "provider_failed";
    super(stepId, reason, `Runtime rejected for step "${stepId}": ${msg}`);
    this.name = "TransportUnavailableError";
  }
}

/** Budget tracker — shared across all completion calls in a sleep cycle. */
export class LlmBudget {
  private state: SleepState;
  private readonly statePath: string;
  exhausted = false;

  constructor(state: SleepState, statePath: string) {
    this.state = state;
    this.statePath = statePath;
  }

  /** Increment counter, return false if budget exhausted. */
  consume(): boolean {
    this.state.llmCalls = (this.state.llmCalls ?? 0) + 1;
    writeStateFile(this.statePath, this.state);
    if (this.state.llmCalls > getAbmindEnv().sleepMaxLlmCalls) {
      this.exhausted = true;
      return false;
    }
    return true;
  }

  get calls(): number { return this.state.llmCalls ?? 0; }
}

/**
 * Send one prompt through the host runtime with bounded domain retry for
 * empty/invalid responses, under one absolute logical-step deadline.
 *
 * - A runtime rejection is NOT retried here — it propagates immediately as a
 *   typed SleepModelFailureError (provider_failed / provider_timeout).
 * - The broker's own deadline error maps to `step_deadline`.
 * - Exhaustion of MAX_DOMAIN_RETRIES empty responses maps to `invalid_response`.
 * - Once cleanup headroom has begun, a call/retry is refused with
 *   `step_deadline` without touching the host.
 *
 * Returns null ONLY when the budget is already exhausted (call not made) or
 * the caller's signal aborted (cancellation) — the orchestrator's own
 * suspend/cancel paths.
 */
export async function sendToRuntime(
  runtime: SleepRuntime,
  prompt: string,
  stepId: string,
  runId: string,
  signal: AbortSignal,
  deadlineAt: number,
  budget?: LlmBudget,
  delayMs = 6000,
  clockNow: () => number = Date.now,
): Promise<string | null> {
  if (budget?.exhausted) {
    logWarn(TAG, `[BUDGET] LLM call limit (${getAbmindEnv().sleepMaxLlmCalls}) reached at step ${stepId} — suspending`);
    return null;
  }

  let emptyAttempts = 0;
  while (true) {
    if (signal.aborted) return null;

    // #1611: refuse to start a call/retry once cleanup headroom has begun.
    // The deadline is absolute — a retry never restarts the clock.
    const remaining = deadlineAt - clockNow();
    if (remaining <= SLEEP_PROVIDER_CLEANUP_HEADROOM_MS) {
      throw new SleepModelFailureError(
        stepId,
        "step_deadline",
        `Logical step ${stepId} deadline reached with ${Math.max(0, remaining)}ms left — not starting another provider call`,
      );
    }

    const request: SleepCompletionRequest = { prompt, stepId, runId, signal, deadlineAt };
    let result: string;
    try {
      result = await runtime.complete(request);
    } catch (err) {
      if (err instanceof SleepCompletionDeadlineError) {
        // #1611: the broker's completion deadline expired — terminal for the
        // logical step, unlike #1603's continue-the-cycle policy.
        budget?.consume(); // real model time was spent
        throw new SleepModelFailureError(stepId, "step_deadline", `Step ${stepId} exceeded its completion deadline`);
      }
      // Transport failure — model unreachable via the host's own transport.
      // No abmind-side backoff/retry window: the host has already exhausted
      // its provider policy. Surface immediately as a terminal typed error.
      throw new TransportUnavailableError(stepId, err);
    }

    // Real call reached the model — count it now (success OR empty, never a throw).
    if (budget && !budget.consume()) {
      logWarn(TAG, `[BUDGET] LLM call limit (${getAbmindEnv().sleepMaxLlmCalls}) reached at step ${stepId} — suspending`);
      return null;
    }

    if (!result || !result.trim()) {
      emptyAttempts++;
      logWarn(TAG, `Step ${stepId} attempt ${emptyAttempts}/${MAX_DOMAIN_RETRIES} returned empty response`);
      if (emptyAttempts >= MAX_DOMAIN_RETRIES) {
        logError(TAG, `Step ${stepId} failed after ${MAX_DOMAIN_RETRIES} attempts (empty)`);
        throw new SleepModelFailureError(
          stepId,
          "invalid_response",
          `Step ${stepId} returned empty/invalid responses ${MAX_DOMAIN_RETRIES} times`,
        );
      }
      if (signal.aborted) return null;
      if (delayMs > 0) await new Promise<void>(r => setTimeout(r, delayMs));
      continue;
    }

    return result;
  }
}
