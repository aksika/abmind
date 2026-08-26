/**
 * sleep/step-deadlines.ts — per-logical-step end-to-end budgets (#1611).
 *
 * One logical sleep step (queueing + every model subcall + same-model domain
 * retries) owns exactly one absolute deadline. Values now come from the
 * `sleep.json` manifest (sleep/sleep-manifest.ts); this module keeps only the
 * deadline mechanics and the unknown-step default.
 *
 * The provider execution cutoff reserves SLEEP_PROVIDER_CLEANUP_HEADROOM_MS
 * before the logical deadline for exact session quarantine, broker failure
 * settlement, and run shutdown. A call or retry must not start once cleanup
 * headroom has begun.
 */

import { sleepStepConfig } from "./sleep-manifest.js";

/** Reserved before the logical step deadline for quarantine, broker failure
 *  settlement, and run shutdown. */
export const SLEEP_PROVIDER_CLEANUP_HEADROOM_MS = 30_000;

/** Budget for unknown/custom steps and the `basic` level. */
export const DEFAULT_SLEEP_STEP_DEADLINE_MS = 300_000;

/** Strips one leading `catch-up-` prefix so catch-up steps inherit the budget
 *  of the underlying step. Unknown/custom step ids use the 300s default. */
export function sleepStepDeadlineMs(stepId: string): number {
  const normalized = stepId.startsWith("catch-up-") ? stepId.slice("catch-up-".length) : stepId;
  return sleepStepConfig(normalized)?.timeoutMs ?? DEFAULT_SLEEP_STEP_DEADLINE_MS;
}
