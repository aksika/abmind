/**
 * sleep/state.ts — shared sleep state types, state-file serialization, and the
 * step-lifecycle event helper.
 *
 * Extracted from orchestrator.ts (#1229 / #208 Stage 2). Owns the SleepState
 * shape so sibling sleep modules (locks, catchup, orchestrator) share one
 * definition without a back-edge into orchestrator. fireOnStep + SleepStepEvent
 * live here too: both runCatchUp (catchup.ts) and runSleepCycle
 * (orchestrator.ts) emit step events, so the helper must be importable by both
 * without a catchup → orchestrator cycle.
 */
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteSync } from "../atomic-write.js";

// ── Step-lifecycle events (#895) ────────────────────────────────────────────

/** Step-lifecycle event fired by the orchestrator at each step boundary (#895).
 *  Best-effort — a throwing handler must never break memory consolidation. */
export interface SleepStepEvent {
  /** Step name, e.g. "extract-memories". */
  name: string;
  /** Source filename, e.g. "03-extract-memories.md". */
  filename: string;
  /** 1-based step index within the run. */
  index: number;
  /** Total steps in this run (loaded from loadSleepSteps() at cycle start). */
  total: number;
  /** "start" fired before the step runs, "done"/"skipped"/"failed" on resolution. */
  phase: "start" | "done" | "skipped" | "failed";
}

/** Best-effort onStep invoker — swallow handler errors so a display callback
 *  can never break the pipeline. */
export function fireOnStep(handler: ((e: SleepStepEvent) => void) | undefined, e: SleepStepEvent): void {
  if (!handler) return;
  try { handler(e); } catch { /* host display only — never fail the cycle */ }
}

// ── State file types ────────────────────────────────────────────────────────

export type StepStatus = "ok" | "failed" | "skipped" | "pending" | "timeout";
export type StepResult = { status: StepStatus; duration?: number; attempts?: number; ctxBefore?: number; ctxAfter?: number; path?: string };
export type WiredResults = { purged: number; deduped: number; embedded: number; anomaliesFixed: number; walOk: boolean; ftsOk: boolean; logsDeleted: number };
export type SleepStatus = "ongoing" | "completed" | "suspended" | "failed";
export type SleepState = { status: SleepStatus; pid: number; startedAt: number; llmCalls: number; wiredResults?: WiredResults; steps: Record<string, StepResult> };

export function readStateFile(path: string): SleepState | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof raw !== "object" || raw === null || !raw.steps) return null;
    // Backfill defaults for legacy lock files
    if (!raw.status) raw.status = "ongoing";
    if (raw.llmCalls == null) raw.llmCalls = 0;
    return raw as SleepState;
  } catch { return null; }
}

export function writeStateFile(path: string, state: SleepState): void {
  atomicWriteSync(path, JSON.stringify(state, null, 2));
}
