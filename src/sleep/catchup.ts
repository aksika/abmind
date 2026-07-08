/**
 * sleep/catchup.ts — Catch-up orchestration for incomplete previous-day sleep cycles.
 * Extracted from orchestrator.ts (#1229).
 */

import { existsSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { getAbmindEnv } from "../env-schema.js";
import { buildDailySummary, writeDailyFile, LLMUnavailableError, extractFromDaily } from "../sleep-pipeline.js";
import { logInfo, logWarn, logError } from "../mem-logger.js";
import type { SleepStep } from "../sleep-pipeline.js";
import type { SleepRuntime } from "./runtime.js";
import type { SleepDataAccess } from "../sleep-data-access.js";
import { writeStateFile, fireOnStep } from "./state.js";
import type { SleepState, SleepStepEvent } from "./state.js";
import type { PreviousLock } from "./locks.js";
import { dateStrToMs, dateStrToFormatted } from "./locks.js";
import { sendWithRetry } from "./llm-budget.js";
import type { LlmBudget } from "./llm-budget.js";
import type { RawArgs } from "./orchestrator.js";

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

export async function runCatchUp(
  locks: PreviousLock[],
  sleepData: SleepDataAccess,
  memoryConfig: { memoryDir: string },
  steps: SleepStep[],
  flags: RawArgs,
  runtime: SleepRuntime,
  budget?: LlmBudget,
  retryDelayMs = 6000,
  onStep?: (e: SleepStepEvent) => void,
): Promise<void> {
  for (const lock of locks) {
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
      try {
        const ctxWindow = getAbmindEnv().sleepCtxWindow;
        const userId = sleepData.getPrimaryUserId();
        const dayStart = dateStrToMs(lock.dateStr);
        const dayEnd = dayStart + 86400000;
        const summary = await buildDailySummary(sleepData.getDb(), (p) => sendWithRetry(runtime, p, "catch-up-04a", flags.verbose, budget, retryDelayMs).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }), {
          ctxWindow, memoryDir: memoryConfig.memoryDir, userId, watermarkTs: 0,
          dateRange: { startTs: dayStart, endTs: dayEnd },
        });
        if (summary) {
          writeDailyFile(memoryConfig.memoryDir, dateStrToFormatted(lock.dateStr), summary);
          lock.state.steps["daily-summary"] = { status: "ok", duration: Math.round((Date.now() - start) / 100) / 10 };
        } else {
          lock.state.steps["daily-summary"] = { status: "skipped" };
        }
        logInfo(TAG, `[CATCH-UP] ✓ 04a-daily-summary for ${lock.dateStr} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
        fireOnStep(onStep, {
          name: "daily-summary", filename: "catch-up",
          index: 0, total: 0,
          phase: summary ? "done" : "skipped",
        });
      } catch (err) {
        logWarn(TAG, `[CATCH-UP] ✗ 04a-daily-summary for ${lock.dateStr}: ${err instanceof Error ? err.message : String(err)}`);
        lock.state.steps["daily-summary"] = { status: "failed", duration: Math.round((Date.now() - start) / 100) / 10 };
        fireOnStep(onStep, {
          name: "daily-summary", filename: "catch-up",
          index: 0, total: 0,
          phase: "failed",
        });
      }
      writeStateFile(lock.path, lock.state);
    }

    // 04b — extract memories from daily (needs daily file to exist)
    if (needed.includes("extract-memories")) {
      const dailyPath = join(memoryConfig.memoryDir, "daily", `daily_${dateStrToFormatted(lock.dateStr)}.md`);
      if (!existsSync(dailyPath)) {
        logInfo(TAG, `[CATCH-UP] ⏭ 04b — no daily file for ${lock.dateStr}`);
        lock.state.steps["extract-memories"] = { status: "skipped" };
        fireOnStep(onStep, {
          name: "extract-memories", filename: "catch-up",
          index: 0, total: 0,
          phase: "skipped",
        });
      } else {
        const start = Date.now();
        try {
          const userId = sleepData.getPrimaryUserId();
          const result = await extractFromDaily(dailyPath, userId, (p) => sendWithRetry(runtime, p, "catch-up-04b", flags.verbose, budget, retryDelayMs).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }));
          lock.state.steps["extract-memories"] = { status: "ok", duration: Math.round((Date.now() - start) / 100) / 10 };
          logInfo(TAG, `[CATCH-UP] ✓ 04b-extract-memories for ${lock.dateStr} (${((Date.now() - start) / 1000).toFixed(1)}s) — ${result.slice(0, 80)}`);
          fireOnStep(onStep, {
            name: "extract-memories", filename: "catch-up",
            index: 0, total: 0,
            phase: "done",
          });
        } catch (err) {
          logWarn(TAG, `[CATCH-UP] ✗ 04b for ${lock.dateStr}: ${err instanceof Error ? err.message : String(err)}`);
          lock.state.steps["extract-memories"] = { status: "failed", duration: Math.round((Date.now() - start) / 100) / 10 };
          fireOnStep(onStep, {
            name: "extract-memories", filename: "catch-up",
            index: 0, total: 0,
            phase: "failed",
          });
        }
      }
      writeStateFile(lock.path, lock.state);
    }

    // Prompt-driven essentials (retrospective)
    for (const stepName of ["retrospective"] as const) {
      if (!needed.includes(stepName)) continue;
      const step = steps.find(s => s.name === stepName);
      if (!step) { logWarn(TAG, `[CATCH-UP] Step file not found: ${stepName}`); continue; }
      const start = Date.now();
      const response = await sendWithRetry(runtime, step.rawPrompt, `catch-up-${stepName}`, flags.verbose, budget, retryDelayMs);
      if (response) {
        lock.state.steps[stepName] = { status: "ok", duration: Math.round((Date.now() - start) / 100) / 10 };
        logInfo(TAG, `[CATCH-UP] ✓ ${stepName} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
        fireOnStep(onStep, {
          name: stepName, filename: "catch-up",
          index: 0, total: 0,
          phase: "done",
        });
      } else {
        lock.state.steps[stepName] = { status: "failed", duration: Math.round((Date.now() - start) / 100) / 10 };
        logWarn(TAG, `[CATCH-UP] ✗ ${stepName}`);
        fireOnStep(onStep, {
          name: stepName, filename: "catch-up",
          index: 0, total: 0,
          phase: "failed",
        });
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
