/**
 * review.ts — #1653 deterministic pre-settlement review (#1838 Part 1).
 *
 * Verbatim move from src/sleep/orchestrator.ts (lines 1432-1560 @ 927deb7).
 * No logic touched. countNonObservationExtractions is exported so the
 * orchestrator's review block can call it without duplication.
 */

import { MemoryManager, getMemoryDb } from "../memory-manager.js";
import type { SleepState } from "./state.js";

// ── #1653: deterministic pre-settlement review ──────────────────────────────
// A pure, bounded judgment over the truthful step results and artifacts that
// exist AFTER the step loop and BEFORE lock settlement, watermark advancement,
// garbage deletion, and old-message flushing. It never calls a model and
// consumes no budget. Only `ok` steps may be downgraded to `failed`; all other
// StepResult fields are preserved.

export type ReviewFindingCode =
  | "step_failed"
  | "daily_artifact_unusable"
  | "no_extraction_writes"
  | "budget_without_output";

export interface ReviewFinding {
  stepId: string;
  code: ReviewFindingCode;
  /** Stable, bounded, deterministic human-readable text — no response content,
   *  prompt text, path, memory content, or secret. */
  detail: string;
  /** Whether this finding invalidates an `ok` step and rewrites it to failed. */
  downgrade: boolean;
  /** Whether the run must be left resumable for an explicit `/sleep resume`. */
  repeat: boolean;
}

/** Explicit inputs to the review — the only way the review learns facts. */
export interface SleepReviewFacts {
  bufferedMessageCount: number;
  /** Non-observation extraction count in the run window; null when the query
   *  was not relevant and therefore not executed. */
  extractedMemoryCount: number | null;
  stepCalls: (stepId: string) => number;
  /** Accepted domain output length per step; absent = no recorded output. */
  acceptedOutputChars: ReadonlyMap<string, number>;
  /** null when daily-summary is not `ok` or recorded no path (no artifact fact). */
  dailyArtifactUsable: boolean | null;
}

/**
 * Deterministic review over persisted step statuses plus run-local facts.
 * Existing failed/timeout has precedence; at most one finding per step, in
 * loaded step order. Exported for direct deterministic-input tests only — not
 * part of the public contract surface (see SUPPORTED-SURFACE.md).
 */
export function evaluateSleepReview(
  state: SleepState,
  facts: SleepReviewFacts,
  stepOrder: readonly string[],
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const seen = new Set<string>();
  const order = [...stepOrder, ...Object.keys(state.steps).filter(k => !stepOrder.includes(k))];

  for (const stepId of order) {
    if (seen.has(stepId)) continue;
    seen.add(stepId);
    const s = state.steps[stepId];
    if (!s) continue;

    if (s.status === "failed" || s.status === "timeout") {
      findings.push({
        stepId,
        code: "step_failed",
        detail: "step did not complete",
        downgrade: false,
        repeat: true,
      });
      continue;
    }
    if (s.status !== "ok") continue; // skipped/pending: no derived rule applies

    const calls = facts.stepCalls(stepId);
    const outputChars = facts.acceptedOutputChars.get(stepId) ?? 0;

    if (stepId === "daily-summary" && facts.dailyArtifactUsable === false) {
      findings.push({
        stepId,
        code: "daily_artifact_unusable",
        detail: "daily artifact missing or unusable",
        downgrade: true,
        repeat: true,
      });
      continue;
    }

    if (
      stepId === "extract-memories"
      && facts.bufferedMessageCount > 0
      && calls > 0
      && facts.extractedMemoryCount === 0
    ) {
      findings.push({
        stepId,
        code: "no_extraction_writes",
        detail: "no extraction writes",
        downgrade: true,
        repeat: true,
      });
      continue;
    }

    if (calls > 0 && outputChars === 0) {
      findings.push({
        stepId,
        code: "budget_without_output",
        detail: "budget consumed without output",
        downgrade: true,
        repeat: true,
      });
    }
  }

  return findings;
}

/** Bounded count of the primary user's non-observation memories created in the
 *  run window. Count only — content never leaves the query (#1653). */
export function countNonObservationExtractions(memory: MemoryManager, userId: string, fromMs: number, toMs: number): number {
  try {
    const memDb = getMemoryDb(memory);
    if (!memDb) return 0;
    const row = memDb.prepare(
      `SELECT COUNT(*) AS count FROM extracted_memories WHERE user_id = ? AND created_at >= ? AND created_at <= ? AND memory_type != 'observation'`,
    ).get(userId, fromMs, toMs) as { count: number } | undefined;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}
