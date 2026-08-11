/**
 * sleep/step-deadlines.ts — per-logical-step end-to-end budgets (#1611).
 *
 * One logical sleep step (queueing + every model subcall + same-model domain
 * retries) owns exactly one absolute deadline. This module centralizes the
 * policy table so observed successful durations can tune budgets without
 * changing deadline mechanics.
 *
 * The provider execution cutoff reserves SLEEP_PROVIDER_CLEANUP_HEADROOM_MS
 * before the logical deadline for exact session quarantine, broker failure
 * settlement, and run shutdown. A call or retry must not start once cleanup
 * headroom has begun.
 */

/** Reserved before the logical step deadline for quarantine, broker failure
 *  settlement, and run shutdown. */
export const SLEEP_PROVIDER_CLEANUP_HEADROOM_MS = 30_000;

/** Budget for unknown/custom steps and the `basic` level. */
export const DEFAULT_SLEEP_STEP_DEADLINE_MS = 300_000;

const STEP_BUDGET_MS: Readonly<Record<string, number>> = {
  "gc-noise": 180_000,
  feedback: 180_000,
  translation: 180_000,
  retrospective: 300_000,
  "contradiction-and-graph": 300_000,
  "retro-derive": 300_000,
  "memory-maintenance": 300_000,
  "skill-review": 300_000,
  consolidation: 300_000,
  "rem-synthesis": 300_000,
  "daily-summary": 600_000,
  "extract-memories": 600_000,
  basic: 300_000,
};

/** Strips one leading `catch-up-` prefix so catch-up steps inherit the budget
 *  of the underlying step. Unknown/custom step ids use the 300s default. */
export function sleepStepDeadlineMs(stepId: string): number {
  const normalized = stepId.startsWith("catch-up-") ? stepId.slice("catch-up-".length) : stepId;
  return STEP_BUDGET_MS[normalized] ?? DEFAULT_SLEEP_STEP_DEADLINE_MS;
}
