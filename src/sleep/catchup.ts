/**
 * sleep/catchup.ts — Catch-up orchestration for incomplete previous-day sleep cycles.
 */

import { existsSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { getAbmindEnv } from "../env-schema.js";
import { buildDailySummary, writeDailyFile, LLMUnavailableError, extractFromDaily } from "../sleep-pipeline.js";
import { logInfo, logWarn, logError } from "../mem-logger.js";
import type { SleepStep } from "../sleep-pipeline.js";
import type { SleepRuntime, SleepEvent, SleepFailure, SleepFailureCause, SleepStepSummary } from "./contracts.js";
import { emitSleepEvent } from "./contracts.js";
import type { SleepDataAccess } from "../sleep-data-access.js";
import { writeStateFile } from "./state.js";
import type { SleepState } from "./state.js";
import type { PreviousLock } from "./locks.js";
import { dateStrToMs, dateStrToFormatted } from "./locks.js";
import { sendToRuntime, DEFAULT_RETRY_DELAYS, isSleepModelFailure } from "./llm-budget.js";
import type { LlmBudget } from "./llm-budget.js";
import type { SleepModelFailureReason } from "./llm-budget.js";
import { sleepStepDeadlineMs } from "./step-deadlines.js";
import { loadSleepManifest } from "./sleep-manifest.js";
import { redactSecrets } from "../redact-secrets.js";

const TAG = "abmind-sleep";

/** Steps whose failure blocks watermark advance. Derived lazily from the
 *  manifest (a module constant would read operator config at import time). */
export function essentialSleepSteps(): ReadonlySet<string> {
  return new Set(loadSleepManifest().filter(s => s.essential).map(s => s.name));
}

export const CATCHUP_MAX_AGE_DAYS = 3;

export function failedEssentials(state: SleepState): string[] {
  const essentials = essentialSleepSteps();
  const failed: string[] = [];
  for (const name of essentials) {
    const s = state.steps[name];
    if (!s || s.status === "failed" || s.status === "timeout" || s.status === "pending") {
      failed.push(name);
    }
  }
  return failed;
}

export interface CatchUpFailure {
  stepId: string;
  reason: SleepModelFailureReason;
  failure: SleepFailure;
}

const SLEEP_FAILURE_CAUSES: ReadonlySet<string> = new Set([
  "provider_failed", "provider_timeout", "step_deadline", "invalid_response",
  "prompt_round_limit", "candidate_round_limit", "candidate_exhausted", "policy_rejected",
  "nonzero_exit", "spawn_error", "timeout", "aborted", "shell_syntax_error", "repeated_failure",
  "memory_validation", "memory_not_found", "memory_conflict", "memory_unauthorized",
  "memory_idempotency_conflict", "memory_unavailable", "memory_outcome_unknown",
  "completion_settlement_failed", "service_failed", "unknown",
]);

const MODEL_REASON_CAUSES: Record<SleepModelFailureReason, SleepFailureCause> = {
  provider_failed: "provider_failed",
  provider_timeout: "provider_timeout",
  step_deadline: "step_deadline",
  invalid_response: "invalid_response",
};

function failureFromError(err: unknown, fallbackCause: SleepFailureCause = "unknown"): SleepFailure {
  const raw = err && typeof err === "object" && !Array.isArray(err)
    ? (err as Record<string, unknown>)
    : undefined;
  const candidate = raw?.failure && typeof raw.failure === "object" && !Array.isArray(raw.failure)
    ? raw.failure as Record<string, unknown>
    : raw;
  const cause = typeof candidate?.cause === "string" && SLEEP_FAILURE_CAUSES.has(candidate.cause)
    ? candidate.cause as SleepFailureCause
    : fallbackCause;
  let message: string;
  try {
    message = err instanceof Error ? err.message : String(err);
  } catch {
    message = "unknown failure";
  }
  const rawDetail = typeof candidate?.detail === "string" ? candidate.detail : message;
  const detail = redactSecrets(rawDetail).slice(0, 240);
  const failure: SleepFailure = { cause };
  if (detail) failure.detail = detail;
  if (typeof candidate?.commandFingerprint === "string" && /^[0-9a-f]{16}$/i.test(candidate.commandFingerprint)) {
    failure.commandFingerprint = candidate.commandFingerprint;
  }
  return failure;
}

function modelReasonForFailure(failure: SleepFailure): SleepModelFailureReason {
  switch (failure.cause) {
    case "provider_timeout": return "provider_timeout";
    case "step_deadline": return "step_deadline";
    case "invalid_response": return "invalid_response";
    default: return "provider_failed";
  }
}

function stepSummary(
  id: string,
  status: "completed" | "skipped" | "failed" | "timeout",
  durationMs?: number,
  failure?: SleepFailure,
): SleepStepSummary {
  return { id, status, essential: true, attempts: 1, durationMs, ...(failure ? { failure } : {}) };
}

function recordModelFailure(
  lock: PreviousLock,
  stepName: string,
  start: number,
  err: { reason: SleepModelFailureReason; failure?: SleepFailure; message: string },
  runId: string,
  onEvent?: (event: SleepEvent) => void,
): CatchUpFailure {
  const status = err.reason === "step_deadline" || err.reason === "provider_timeout" ? "timeout" : "failed";
  const failure = failureFromError(err, MODEL_REASON_CAUSES[err.reason]);
  logWarn(TAG, `[CATCH-UP] ✗ ${stepName} for ${lock.dateStr}: terminal model failure (${err.reason}) — stopping sleep`);
  lock.state.steps[stepName] = {
    status,
    essential: true,
    duration: Math.round((Date.now() - start) / 100) / 10,
    failure,
  };
  writeStateFile(lock.path, lock.state);
  emitSleepEvent(onEvent, { type: "step_failed", runId, step: stepSummary(stepName, status, Date.now() - start, failure) });
  return { stepId: stepName, reason: err.reason, failure };
}

/** Record any catch-up failure as terminal. A prior-day failure is still a
 * current-cycle failure: continuing would let the current cycle advance its
 * watermark while the older checkpoint remains unrecovered. */
function recordCatchUpFailure(
  lock: PreviousLock,
  stepName: string,
  start: number,
  failure: SleepFailure,
  runId: string,
  onEvent?: (event: SleepEvent) => void,
): CatchUpFailure {
  const reason = modelReasonForFailure(failure);
  const status = reason === "step_deadline" || reason === "provider_timeout" ? "timeout" : "failed";
  logWarn(TAG, `[CATCH-UP] ✗ ${stepName} for ${lock.dateStr}: terminal failure (${failure.cause}) — stopping sleep`);
  lock.state.steps[stepName] = {
    status,
    essential: true,
    duration: Math.round((Date.now() - start) / 100) / 10,
    failure,
  };
  writeStateFile(lock.path, lock.state);
  emitSleepEvent(onEvent, { type: "step_failed", runId, step: stepSummary(stepName, status, Date.now() - start, failure) });
  return { stepId: stepName, reason, failure };
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
  retryDelays: readonly number[] = DEFAULT_RETRY_DELAYS,
  onEvent?: (event: SleepEvent) => void,
): Promise<CatchUpFailure | null> {
  for (const lock of locks) {
    if (signal.aborted) return null;

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
        summary = await buildDailySummary(sleepData.getDb(), (p) => sendToRuntime(runtime, p, "catch-up-daily-summary", runId, signal, deadlineAt, budget, retryDelays).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }), {
          ctxWindow, memoryDir: memoryConfig.memoryDir, userId, watermarkTs: 0,
          dateRange: { startTs: dayStart, endTs: dayEnd },
        });
        if (summary) {
          writeDailyFile(memoryConfig.memoryDir, dateStrToFormatted(lock.dateStr), summary);
          lock.state.steps["daily-summary"] = { status: "ok", essential: true, duration: Math.round((Date.now() - start) / 100) / 10 };
        } else {
          lock.state.steps["daily-summary"] = { status: "skipped", essential: true };
        }
        logInfo(TAG, `[CATCH-UP] ${summary ? "✓" : "⏭"} daily-summary for ${lock.dateStr} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
        emitSleepEvent(onEvent, { type: summary ? "step_completed" : "step_skipped", runId, step: stepSummary("daily-summary", summary ? "completed" : "skipped", Date.now() - start) });
      } catch (err) {
        if (isSleepModelFailure(err)) {
          // #1611/#1752: return the typed failure to the orchestrator. A
          // catch-up error must not escape as a generic service failure, or
          // the final report loses its stage/cause and resumability.
          return recordModelFailure(lock, "daily-summary", start, err, runId, onEvent);
        }
        return recordCatchUpFailure(lock, "daily-summary", start, failureFromError(err), runId, onEvent);
      }
      writeStateFile(lock.path, lock.state);
    }

    if (signal.aborted) return null;

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
          const result = await extractFromDaily(dailyPath, userId, (p) => sendToRuntime(runtime, p, "catch-up-extract-memories", runId, signal, deadlineAt, budget, retryDelays).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }));
          lock.state.steps["extract-memories"] = { status: "ok", essential: true, duration: Math.round((Date.now() - start) / 100) / 10 };
          logInfo(TAG, `[CATCH-UP] ✓ extract-memories for ${lock.dateStr} (${((Date.now() - start) / 1000).toFixed(1)}s) — ${result.slice(0, 80)}`);
          emitSleepEvent(onEvent, { type: "step_completed", runId, step: stepSummary("extract-memories", "completed", Date.now() - start) });
        } catch (err) {
          if (isSleepModelFailure(err)) {
            return recordModelFailure(lock, "extract-memories", start, err, runId, onEvent);
          }
          return recordCatchUpFailure(lock, "extract-memories", start, failureFromError(err), runId, onEvent);
        }
      }
      writeStateFile(lock.path, lock.state);
    }

    if (signal.aborted) return null;

    // Prompt-driven essentials (retrospective) — #1752 R7: requires daily artifact
    for (const stepName of ["retrospective"] as const) {
      if (!needed.includes(stepName)) continue;
      const step = steps.find(s => s.name === stepName);
      if (!step) {
        logWarn(TAG, `[CATCH-UP] Step file not found: ${stepName}`);
        return recordCatchUpFailure(
          lock,
          stepName,
          Date.now(),
          { cause: "unknown", detail: `catch-up step definition not found: ${stepName}` },
          runId,
          onEvent,
        );
      }
      const dailyPath = join(memoryConfig.memoryDir, "daily", `daily_${dateStrToFormatted(lock.dateStr)}.md`);
      // If daily artifact missing/unusable, skip retrospective and leave daily-summary for review/catch-up
      if (!existsSync(dailyPath)) {
        logInfo(TAG, `[CATCH-UP] ⏭ ${stepName} for ${lock.dateStr} — no daily file, skipping`);
        lock.state.steps[stepName] = { status: "skipped", essential: true };
        writeStateFile(lock.path, lock.state);
        emitSleepEvent(onEvent, { type: "step_skipped", runId, step: stepSummary(stepName, "skipped") });
        continue;
      }
      try {
        const { readDailyArtifact } = await import("./sleep-extract-daily.js");
        if (!readDailyArtifact(dailyPath).usable) {
          logWarn(TAG, `[CATCH-UP] ⏭ ${stepName} for ${lock.dateStr} — daily artifact unusable, skipping`);
          lock.state.steps[stepName] = { status: "skipped", essential: true };
          writeStateFile(lock.path, lock.state);
          emitSleepEvent(onEvent, { type: "step_skipped", runId, step: stepSummary(stepName, "skipped") });
          continue;
        }
      } catch {}
      const start = Date.now();
      const deadlineAt = Date.now() + sleepStepDeadlineMs(`catch-up-${stepName}`);
      let response: string | null;
      // #1752 R7: substitute actual daily path into retrospective prompt (catch-up uses lock date, not current date)
      const rawPrompt = step.rawPrompt.replace(/\$\{DAILY_PATH\}/g, dailyPath).replace(/\$\{RETRO_PATH\}/g, dailyPath);
      try {
        response = await sendToRuntime(runtime, rawPrompt, `catch-up-${stepName}`, runId, signal, deadlineAt, budget, retryDelays);
      } catch (err) {
        if (isSleepModelFailure(err)) {
          // #1752 R9: retrospective empty but artifact present — don't fail for missing closing prose (catch-up)
          if ((err as { reason?: string }).reason === "invalid_response") {
            try {
              const { readDailyArtifact } = await import("./sleep-extract-daily.js");
              if (readDailyArtifact(dailyPath).usable) {
                logInfo(TAG, `[CATCH-UP] ${stepName} empty but artifact present (${dailyPath}) — marking ok per R9`);
                lock.state.steps[stepName] = { status: "ok", essential: true, duration: Math.round((Date.now() - start) / 100) / 10 };
                writeStateFile(lock.path, lock.state);
                emitSleepEvent(onEvent, { type: "step_completed", runId, step: stepSummary(stepName, "completed", Date.now() - start) });
                continue;
              }
            } catch {}
          }
          // #1752 R11: invalid_response on non-essential catch-up would continue, but retrospective is essential — keep terminal
          return recordModelFailure(lock, stepName, start, err as { reason: SleepModelFailureReason; failure?: SleepFailure; message: string }, runId, onEvent);
        }
        return recordCatchUpFailure(lock, stepName, start, failureFromError(err), runId, onEvent);
      }
      if (response) {
        lock.state.steps[stepName] = { status: "ok", essential: true, duration: Math.round((Date.now() - start) / 100) / 10 };
        logInfo(TAG, `[CATCH-UP] ✓ ${stepName} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
        emitSleepEvent(onEvent, { type: "step_completed", runId, step: stepSummary(stepName, "completed", Date.now() - start) });
      } else {
        if (response === "" ) {
          try {
            const { readDailyArtifact } = await import("./sleep-extract-daily.js");
            if (readDailyArtifact(dailyPath).usable) {
              logInfo(TAG, `[CATCH-UP] ${stepName} empty but artifact present — marking ok per R9`);
              lock.state.steps[stepName] = { status: "ok", essential: true, duration: Math.round((Date.now() - start) / 100) / 10 };
              writeStateFile(lock.path, lock.state);
              emitSleepEvent(onEvent, { type: "step_completed", runId, step: stepSummary(stepName, "completed", Date.now() - start) });
              continue;
            }
          } catch {}
        }
        // sendToRuntime returns null for cancellation or exhausted budget;
        // cancellation belongs to the outer run's cancel path, while an
        // exhausted catch-up must remain a terminal, reportable failure.
        if (signal.aborted) return null;
        const failure: SleepFailure = budget?.exhausted
          ? { cause: "unknown", detail: `sleep LLM call budget exhausted during catch-up: ${stepName}` }
          : { cause: "invalid_response", detail: `catch-up ${stepName} returned no response` };
        return recordCatchUpFailure(lock, stepName, start, failure, runId, onEvent);
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
  return null;
}
