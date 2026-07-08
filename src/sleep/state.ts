/**
 * sleep/state.ts — Sleep state types, state-file IO, wired pre-tasks, and
 * step-lifecycle event helpers.
 * Extracted from orchestrator.ts (#1229).
 */

import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteSync } from "../atomic-write.js";
import { logWarn } from "../mem-logger.js";
import type { MemoryManager } from "../memory-manager.js";
import type { SleepDataAccess } from "../sleep-data-access.js";

const TAG = "abmind-sleep";

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

// ── Step-lifecycle event ─────────────────────────────────────────────────────

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

// ── Wired pre-tasks (delegated to abmind MaintenanceService) ────────────────

export async function runWiredPreTasks(sleepData: SleepDataAccess, memoryDir: string, memory: MemoryManager): Promise<WiredResults> {
  const r = await memory.maintenance.runPreSleepTasks(memory, sleepData);

  // Bridge-side: log rotation (not memory's concern)
  let logsDeleted = 0;
  try {
    const logsDir = join(memoryDir, "..", "logs");
    if (existsSync(logsDir)) {
      const cutoff = Date.now() - 7 * 86400000;
      for (const f of readdirSync(logsDir)) {
        if (!f.startsWith("bridge-") || !f.endsWith(".log")) continue;
        const match = f.match(/bridge-(\d{4}-\d{2}-\d{2})\.log/);
        if (match && new Date(match[1]!).getTime() < cutoff) {
          unlinkSync(join(logsDir, f));
          logsDeleted++;
        }
      }
    }
  } catch (err) { logWarn(TAG, `[WIRED] log rotation: ${err instanceof Error ? err.message : String(err)}`); }

  return { purged: r.purged, deduped: r.deduped, embedded: r.embedded, anomaliesFixed: r.anomaliesFixed, walOk: r.walOk, ftsOk: r.ftsOk, logsDeleted };
}

export function formatWiredResults(r: WiredResults): string {
  const parts: string[] = [];
  if (r.purged > 0) parts.push(`${r.purged} garbage purged`);
  if (r.deduped > 0) parts.push(`${r.deduped} dupes deleted`);
  parts.push(`WAL ${r.walOk ? "ok" : "FAILED"}`);
  parts.push(`FTS ${r.ftsOk ? "ok" : "FAILED"}`);
  if (r.embedded > 0) parts.push(`${r.embedded} embedded`);
  if (r.anomaliesFixed > 0) parts.push(`${r.anomaliesFixed} anomalies fixed`);
  if (r.logsDeleted > 0) parts.push(`${r.logsDeleted} old logs deleted`);
  return parts.length > 0 ? parts.join(", ") : "nothing to do";
}
