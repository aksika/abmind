/**
 * sleep/catchup.ts — Catch-up orchestration for incomplete previous-day sleep cycles.
 */

import { existsSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { getAbmindEnv } from "../env-schema.js";
import { buildDailySummary, writeDailyFile, LLMUnavailableError, extractFromDaily } from "../sleep-pipeline.js";
import { logInfo, logWarn, logError } from "../mem-logger.js";
import type { SleepStep } from "../sleep-pipeline.js";
import type { SleepRuntime, SleepEvent, SleepStepSummary } from "./contracts.js";
import { emitSleepEvent } from "./contracts.js";
import type { SleepDataAccess } from "../sleep-data-access.js";
import { writeStateFile } from "./state.js";
import type { SleepState } from "./state.js";
import type { PreviousLock } from "./locks.js";
import { dateStrToMs, dateStrToFormatted } from "./locks.js";
import { sendToRuntime, isSleepModelFailure } from "./llm-budget.js";
import type { LlmBudget } from "./llm-budget.js";
import { sleepStepDeadlineMs } from "./step-deadlines.js";

const TAG = "abmind-sleep";

/** Steps whose failure blocks watermark advance. Public so tests can derive reject targets. */
export const ESSENTIAL_STEPS: ReadonlySet<string> = new Set(["daily-summary", "extract-memories", "retrospective"]);
export const CATCHUP_MAX_AGE_DAYS = 3;

export function failedEssentials(state: SleepState): string[] {
  const failed: string[] = [];
  for (const name of ESSENTIAL_STEPS) {
    const s = state.steps[name];
    if (!s || s.status === "failed" || s.status === "timeout" || s.status === "pending") {
      failed.push(name);
    }
  }
  return failed;
}

function stepSummary(id: string, status: "completed" | "skipped" | "failed", durationMs?: number): SleepStepSummary {
  return { id, status, essential: true, attempts: 1, durationMs };
}

export async function runCatchUp(
  locks: PreviousLock[],
  sleepData: SleepDataAccess,
  memoryConfig: { memoryDir: string },
  steps: SleepStep[],
  runtime: SleepRuntime,
  runId: string,
  signal: AbortSignal,
  budget?: LlmBudget,
  retryDelayMs = 6000,
  onEvent?: (event: SleepEvent) => void,
): Promise<void> {
  for (const lock of locks) {
    if (signal.aborted) return;

    if (lock.ageDays > CATCHUP_MAX_AGE_DAYS) {
      logError(TAG, `[CATCH-UP] Abandoning stale lock ${basename(lock.path)} — ${lock.ageDays} days old, data unrecoverable`);
      unlinkSync(lock.path);
      continue;
    }

    const needed = failedEssentials(lock.state);
    if (needed.length === 0) {
      logInfo(TAG, `[CATCH-UP] Cleaning up completed lock ${basename(lock.path)}`);
      unlinkSync(lock.path);
      continue;
    }

    logInfo(TAG, `[CATCH-UP] ${basename(lock.path)} — recovering: ${needed.join(", ")}`);

    // 04a — daily summary with date-range
    if (needed.includes("daily-summary")) {
      const start = Date.now();
      let summary: string | null = null;
      try {
        const ctxWindow = getAbmindEnv().sleepCtxWindow;
        const userId = sleepData.getPrimaryUserId();
        const dayStart = dateStrToMs(lock.dateStr);
        const dayEnd = dayStart + 86400000;
        // #1611: catch-up establishes a fresh logical deadline per step; the
        // underlying step's budget applies (catch-up- prefix is stripped).
        const deadlineAt = Date.now() + sleepStepDeadlineMs("catch-up-daily-summary");
        summary = await buildDailySummary(sleepData.getDb(), (p) => sendToRuntime(runtime, p, "catch-up-daily-summary", runId, signal, deadlineAt, budget, retryDelayMs).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }), {
          ctxWindow, memoryDir: memoryConfig.memoryDir, userId, watermarkTs: 0,
          dateRange: { startTs: dayStart, endTs: dayEnd },
        });
        if (summary) {
          writeDailyFile(memoryConfig.memoryDir, dateStrToFormatted(lock.dateStr), summary);
          lock.state.steps["daily-summary"] = { status: "ok", essential: true, duration: Math.round((Date.now() - start) / 100) / 10 };
        } else {
          lock.state.steps["daily-summary"] = { status: "skipped", essential: true };
        }
        logInfo(TAG, `[CATCH-UP] ✓ daily-summary for ${lock.dateStr} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
        emitSleepEvent(onEvent, { type: summary ? "step_completed" : "step_skipped", runId, step: stepSummary("daily-summary", summary ? "completed" : "skipped", Date.now() - start) });
      } catch (err) {
        if (isSleepModelFailure(err)) {
          // #1611: a terminal model failure must stop the whole sleep — record
          // the failed catch-up step, persist its lock, then rethrow.
          logWarn(TAG, `[CATCH-UP] ✗ daily-summary for ${lock.dateStr}: terminal model failure (${err.reason}) — stopping sleep`);
          lock.state.steps["daily-summary"] = {
            status: err.reason === "step_deadline" || err.reason === "provider_timeout" ? "timeout" : "failed",
            essential: true,
            duration: Math.round((Date.now() - start) / 100) / 10,
          };
          writeStateFile(lock.path, lock.state);
          throw err;
        }
        logWarn(TAG, `[CATCH-UP] ✗ daily-summary for ${lock.dateStr}: ${err instanceof Error ? err.message : String(err)}`);
        lock.state.steps["daily-summary"] = { status: "failed", essential: true, duration: Math.round((Date.now() - start) / 100) / 10 };
        emitSleepEvent(onEvent, { type: "step_failed", runId, step: stepSummary("daily-summary", "failed", Date.now() - start) });
      }
      writeStateFile(lock.path, lock.state);
    }

    if (signal.aborted) return;

    // 04b — extract memories from daily (needs daily file to exist)
    if (needed.includes("extract-memories")) {
      const dailyPath = join(memoryConfig.memoryDir, "daily", `daily_${dateStrToFormatted(lock.dateStr)}.md`);
      if (!existsSync(dailyPath)) {
        logInfo(TAG, `[CATCH-UP] ⏭ extract-memories — no daily file for ${lock.dateStr}`);
        lock.state.steps["extract-memories"] = { status: "skipped", essential: true };
        emitSleepEvent(onEvent, { type: "step_skipped", runId, step: stepSummary("extract-memories", "skipped") });
      } else {
        const start = Date.now();
        try {
          const userId = sleepData.getPrimaryUserId();
          const deadlineAt = Date.now() + sleepStepDeadlineMs("catch-up-extract-memories");
          const result = await extractFromDaily(dailyPath, userId, (p) => sendToRuntime(runtime, p, "catch-up-extract-memories", runId, signal, deadlineAt, budget, retryDelayMs).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }));
          lock.state.steps["extract-memories"] = { status: "ok", essential: true, duration: Math.round((Date.now() - start) / 100) / 10 };
          logInfo(TAG, `[CATCH-UP] ✓ extract-memories for ${lock.dateStr} (${((Date.now() - start) / 1000).toFixed(1)}s) — ${result.slice(0, 80)}`);
          emitSleepEvent(onEvent, { type: "step_completed", runId, step: stepSummary("extract-memories", "completed", Date.now() - start) });
        } catch (err) {
          if (isSleepModelFailure(err)) {
            // #1611: terminal model failure — record, persist, and stop the sleep.
            logWarn(TAG, `[CATCH-UP] ✗ extract-memories for ${lock.dateStr}: terminal model failure (${err.reason}) — stopping sleep`);
            lock.state.steps["extract-memories"] = {
              status: err.reason === "step_deadline" || err.reason === "provider_timeout" ? "timeout" : "failed",
              essential: true,
              duration: Math.round((Date.now() - start) / 100) / 10,
            };
            writeStateFile(lock.path, lock.state);
            throw err;
          }
          logWarn(TAG, `[CATCH-UP] ✗ extract-memories for ${lock.dateStr}: ${err instanceof Error ? err.message : String(err)}`);
          lock.state.steps["extract-memories"] = { status: "failed", essential: true, duration: Math.round((Date.now() - start) / 100) / 10 };
          emitSleepEvent(onEvent, { type: "step_failed", runId, step: stepSummary("extract-memories", "failed", Date.now() - start) });
        }
      }
      writeStateFile(lock.path, lock.state);
    }

    if (signal.aborted) return;

    // Prompt-driven essentials (retrospective)
    for (const stepName of ["retrospective"] as const) {
      if (!needed.includes(stepName)) continue;
      const step = steps.find(s => s.name === stepName);
      if (!step) { logWarn(TAG, `[CATCH-UP] Step file not found: ${stepName}`); continue; }
      const start = Date.now();
      const deadlineAt = Date.now() + sleepStepDeadlineMs(`catch-up-${stepName}`);
      let response: string | null;
      try {
        response = await sendToRuntime(runtime, step.rawPrompt, `catch-up-${stepName}`, runId, signal, deadlineAt, budget, retryDelayMs);
      } catch (err) {
        if (isSleepModelFailure(err)) {
          // #1611: terminal model failure — record, persist, and stop the sleep.
          logWarn(TAG, `[CATCH-UP] ✗ ${stepName} for ${lock.dateStr}: terminal model failure (${err.reason}) — stopping sleep`);
          lock.state.steps[stepName] = {
            status: err.reason === "step_deadline" || err.reason === "provider_timeout" ? "timeout" : "failed",
            essential: true,
            duration: Math.round((Date.now() - start) / 100) / 10,
          };
          writeStateFile(lock.path, lock.state);
          throw err;
        }
        throw err;
      }
      if (response) {
        lock.state.steps[stepName] = { status: "ok", essential: true, duration: Math.round((Date.now() - start) / 100) / 10 };
        logInfo(TAG, `[CATCH-UP] ✓ ${stepName} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
        emitSleepEvent(onEvent, { type: "step_completed", runId, step: stepSummary(stepName, "completed", Date.now() - start) });
      } else {
        lock.state.steps[stepName] = { status: "failed", essential: true, duration: Math.round((Date.now() - start) / 100) / 10 };
        logWarn(TAG, `[CATCH-UP] ✗ ${stepName}`);
        emitSleepEvent(onEvent, { type: "step_failed", runId, step: stepSummary(stepName, "failed", Date.now() - start) });
      }
      writeStateFile(lock.path, lock.state);
    }

    // Final check
    const stillFailing = failedEssentials(lock.state);
    if (stillFailing.length === 0) {
      logInfo(TAG, `[CATCH-UP] ✅ ${basename(lock.path)} — all essentials recovered, lock deleted`);
      unlinkSync(lock.path);
    } else {
      logWarn(TAG, `[CATCH-UP] ${basename(lock.path)} — still failing: ${stillFailing.join(", ")} (failing ${lock.ageDays} day(s))`);
    }
  }
}
