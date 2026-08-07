/**
 * sleep/llm-budget.ts — LLM call budget tracking and bounded domain retry.
 *
 * #1353: transport retry/backoff is a host responsibility, not abmind's.
 * `SleepRuntime.complete()` is one host-supervised model operation — if it
 * rejects, the host has already exhausted its own provider retry/fallback
 * policy. Abmind records a transport-unavailable step outcome and follows
 * its existing essential-step stop/suspend rules; it does not sleep and
 * retry the provider itself.
 *
 * The bounded retry that remains here is a DOMAIN retry: a structurally
 * empty or invalid *successful* response is retried a small number of times
 * because another model call is semantically meaningful (the model may
 * simply produce a better answer next time). Every model-reaching attempt —
 * retried or not — is charged to the LLM budget.
 */

import { getAbmindEnv } from "../env-schema.js";
import { logWarn, logError } from "../mem-logger.js";
import { LLMUnavailableError } from "../sleep-pipeline.js";
import type { SleepRuntime, SleepCompletionRequest } from "./contracts.js";
import { writeStateFile } from "./state.js";
import type { SleepState } from "./state.js";
import { SleepCompletionDeadlineError } from "../sleep-service/runtime-broker.js";

const TAG = "abmind-sleep";

/** Bounded retries for an empty/invalid domain response. Not a transport retry. */
export const MAX_DOMAIN_RETRIES = 3;

/** Thrown when the host's `runtime.complete()` rejects — a transport failure,
 *  not a domain one. Extends LLMUnavailableError so buildDailySummary/
 *  extractFromDaily propagate it naturally (they check instanceof
 *  LLMUnavailableError to bubble errors up to the orchestrator). */
export class TransportUnavailableError extends LLMUnavailableError {
  constructor(stepId: string, cause?: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`Runtime rejected for step "${stepId}": ${msg}`);
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
 * empty/invalid responses. A runtime rejection is NOT retried here — it
 * propagates immediately as TransportUnavailableError so the orchestrator
 * can apply its own essential-step stop/suspend policy.
 *
 * Returns null if the budget is already exhausted, or after MAX_DOMAIN_RETRIES
 * consecutive empty responses.
 */
export async function sendToRuntime(
  runtime: SleepRuntime,
  prompt: string,
  stepId: string,
  runId: string,
  signal: AbortSignal,
  budget?: LlmBudget,
  delayMs = 6000,
): Promise<string | null> {
  if (budget?.exhausted) {
    logWarn(TAG, `[BUDGET] LLM call limit (${getAbmindEnv().sleepMaxLlmCalls}) reached at step ${stepId} — suspending`);
    return null;
  }

  let emptyAttempts = 0;
  while (true) {
    if (signal.aborted) return null;

    const request: SleepCompletionRequest = { prompt, stepId, runId, signal };
    let result: string;
    try {
      result = await runtime.complete(request);
    } catch (err) {
      if (err instanceof SleepCompletionDeadlineError) {
        // This completion exceeded its own deadline. The provider is still
        // there: fail the step, keep the cycle. #1279's stop-the-cycle policy
        // applies to transport loss, not to one slow generation.
        logWarn(TAG, `Step ${stepId} exceeded its completion deadline — failing the step, continuing the cycle`);
        budget?.consume(); // real model time was spent
        return null;
      }
      // Transport failure — model unreachable via the host's own transport.
      // No abmind-side backoff/retry window: the host has already exhausted
      // its provider policy. Surface immediately.
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
        logError(TAG, `Step ${stepId} failed after ${MAX_DOMAIN_RETRIES} attempts (empty), skipping`);
        return null;
      }
      if (signal.aborted) return null;
      if (delayMs > 0) await new Promise<void>(r => setTimeout(r, delayMs));
      continue;
    }

    return result;
  }
}
