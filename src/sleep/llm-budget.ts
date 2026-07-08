/**
 * sleep/llm-budget.ts — LLM call budget tracking and retry-with-transport-backoff.
 * Extracted from orchestrator.ts (#1229). Carries the full transport-aware
 * sendWithRetry from #1279.
 */

import { getAbmindEnv } from "../env-schema.js";
import { logWarn, logError, logInfo } from "../mem-logger.js";
import { LLMUnavailableError } from "../sleep-pipeline.js";
import type { SleepRuntime } from "./runtime.js";
import { writeStateFile } from "./state.js";
import type { SleepState } from "./state.js";

const TAG = "abmind-sleep";

export const MAX_RETRIES = 3;
export const TRANSPORT_MAX_RETRIES = 6;
export const DEFAULT_TRANSPORT_RETRY_WINDOW_MS = 8 * 60_000; // 8 minutes

/** Thrown by sendWithRetry when runtime.complete() throws on every attempt within the retry window.
 *  Extends LLMUnavailableError so buildDailySummary and extractFromDaily rethrow it naturally
 *  (those functions check instanceof LLMUnavailableError to propagate errors up). */
export class ModelUnavailableError extends LLMUnavailableError {
  constructor(stepName: string) {
    super(`Model unavailable for step "${stepName}" after retry window`);
    this.name = "ModelUnavailableError";
  }
}

/** Budget tracker — shared across all sendWithRetry calls in a sleep cycle. */
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

export async function sendWithRetry(
  runtime: SleepRuntime,
  prompt: string,
  stepName: string,
  _verbose: boolean,
  budget?: LlmBudget,
  delayMs = 6000,
  transportBackoffMs: (attempt: number) => number = (n) => Math.min(30_000 * Math.pow(2, n - 1), 120_000),
  transportRetryWindowMs = DEFAULT_TRANSPORT_RETRY_WINDOW_MS,
  nowFn: () => number = Date.now,
): Promise<string | null> {
  const deadline = nowFn() + transportRetryWindowMs;
  let emptyAttempts = 0;
  let transportAttempts = 0;

  // Budget-exhaustion pre-check: if we are already over the cap, bail immediately.
  // This mirrors the old pre-loop consume() guard without burning a call.
  if (budget?.exhausted) {
    logWarn(TAG, `[BUDGET] LLM call limit (${getAbmindEnv().sleepMaxLlmCalls}) reached at step ${stepName} — suspending`);
    return null;
  }

  while (true) {
    try {
      const result = await runtime.complete(prompt);

      // Real call reached the model — count it now (success OR empty, never a throw).
      if (budget && !budget.consume()) {
        logWarn(TAG, `[BUDGET] LLM call limit (${getAbmindEnv().sleepMaxLlmCalls}) reached at step ${stepName} — suspending`);
        return null;
      }

      if (!result || !result.trim()) {
        emptyAttempts++;
        logWarn(TAG, `Step ${stepName} attempt ${emptyAttempts}/${MAX_RETRIES} returned empty response`);
        if (emptyAttempts >= MAX_RETRIES) {
          logError(TAG, `Step ${stepName} failed after ${MAX_RETRIES} attempts (empty), skipping`);
          return null;
        }
        if (delayMs > 0) await new Promise<void>(r => setTimeout(r, delayMs));
        continue;
      }

      return result;
    } catch (err) {
      // Transport failure — model unreachable. Do NOT consume budget (no tokens used).
      transportAttempts++;
      const msg = err instanceof Error ? err.message : String(err);
      const backoff = transportBackoffMs(transportAttempts);
      const timeRemaining = deadline - nowFn();
      logWarn(TAG, `Step ${stepName} transport fail (${transportAttempts}/${TRANSPORT_MAX_RETRIES}): ${msg}`);

      if (transportAttempts >= TRANSPORT_MAX_RETRIES || timeRemaining <= backoff) {
        logError(TAG, `Step ${stepName} — model unavailable after ${transportAttempts} attempt(s), ${Math.round(transportRetryWindowMs / 60_000)}min window exhausted`);
        throw new ModelUnavailableError(stepName);
      }

      logInfo(TAG, `[SLEEP] Model unreachable — waiting ${Math.round(backoff / 1000)}s before retry (step ${stepName})`);
      if (backoff > 0) await new Promise<void>(r => setTimeout(r, backoff));
    }
  }
}
