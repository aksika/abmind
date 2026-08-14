/**
 * sleep/state.ts — Sleep state types, state-file IO, wired pre-tasks, and
 * step-lifecycle event helpers.
 * Extracted from orchestrator.ts (#1229).
 */

import { existsSync, readFileSync } from "node:fs";
import { atomicWriteSync } from "../atomic-write.js";
import type { MemoryManager } from "../memory-manager.js";
import type { SleepDataAccess } from "../sleep-data-access.js";

// ── State file types ────────────────────────────────────────────────────────

export type StepStatus = "ok" | "failed" | "skipped" | "pending" | "timeout";
export type StepResult = { status: StepStatus; duration?: number; attempts?: number; ctxBefore?: number; ctxAfter?: number; path?: string; essential?: boolean };
export type WiredResults = { purged: number; deduped: number; embedded: number; anomaliesFixed: number; walOk: boolean; ftsOk: boolean };
export type SleepStatus = "ongoing" | "completed" | "suspended" | "failed";
/** #1353: runId is the stable identity for one execution attempt. priorRunId
 *  records lineage when a run resumes a previous checkpoint (a resumed run
 *  gets its OWN new runId — it does not pretend to be the prior process). */
export type SleepState = { status: SleepStatus; pid: number; runId?: string; priorRunId?: string; startedAt: number; llmCalls: number; wiredResults?: WiredResults; steps: Record<string, StepResult> };

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

// ── Wired pre-tasks (delegated to abmind MaintenanceService) ────────────────
// #1353: bridge-log rotation moved out — abmind may clean only its own
// artifacts below its configured home. Host log retention is host-owned.

export async function runWiredPreTasks(sleepData: SleepDataAccess, _memoryDir: string, memory: MemoryManager, primaryUserId: string): Promise<WiredResults> {
  const r = await memory.maintenance.runPreSleepTasks(memory, sleepData, primaryUserId);
  return { purged: r.purged, deduped: r.deduped, embedded: r.embedded, anomaliesFixed: r.anomaliesFixed, walOk: r.walOk, ftsOk: r.ftsOk };
}

export function formatWiredResults(r: WiredResults): string {
  const parts: string[] = [];
  if (r.purged > 0) parts.push(`${r.purged} garbage purged`);
  if (r.deduped > 0) parts.push(`${r.deduped} dupes deleted`);
  parts.push(`WAL ${r.walOk ? "ok" : "FAILED"}`);
  parts.push(`FTS ${r.ftsOk ? "ok" : "FAILED"}`);
  if (r.embedded > 0) parts.push(`${r.embedded} embedded`);
  if (r.anomaliesFixed > 0) parts.push(`${r.anomaliesFixed} anomalies fixed`);
  return parts.length > 0 ? parts.join(", ") : "nothing to do";
}
