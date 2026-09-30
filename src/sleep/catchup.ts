/**
 * sleep/catchup.ts — Catch-up orchestration for incomplete previous-day sleep cycles.
 */

import { unlinkSync } from "node:fs";
import { basename } from "node:path";
import { getAbmindEnv } from "../env-schema.js";
import { LLMUnavailableError } from "../sleep-pipeline.js";
import { logInfo, logWarn, logError } from "../mem-logger.js";
import type { SleepStep } from "../sleep-pipeline.js";
import type { SleepRuntime, SleepEvent, SleepFailure, SleepFailureCause, SleepStepSummary } from "./contracts.js";
import { emitSleepEvent } from "./contracts.js";
import type { SleepDataAccess } from "../sleep-data-access.js";
import { writeStateFile } from "./state.js";
import type { SleepState } from "./state.js";
import type { PreviousLock } from "./locks.js";
import { dateStrToMs } from "./locks.js";
import { sendToRuntime, DEFAULT_RETRY_DELAYS, isSleepModelFailure } from "./llm-budget.js";
import type { LlmBudget } from "./llm-budget.js";
import type { SleepModelFailureReason } from "./llm-budget.js";
import { sleepStepDeadlineMs } from "./step-deadlines.js";
import { loadSleepManifest } from "./sleep-manifest.js";
import { localISO } from "../local-time.js";
import { writeAuditLog } from "./audit.js";
import { hasUnclaimedRanges, unclaimedRanges, formatRanges } from "./coverage.js";
import {
  runSharedDailySummary,
  runSharedExtraction,
  runSharedRetrospective,
} from "./shared-execution.js";
import { failureFromCatchUpError } from "./failure-report.js";
import { hasAppendedDailyArtifact, readDailyArtifact, readDailyArtifactRaw } from "./sleep-extract-daily.js";
import { prepareStepDispatch } from "./step-prepare.js";
import { readMessagesByDateRange } from "./sleep-daily-summary.js";

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

/**
 * What a lock still needs (#1860): failed essentials plus steps with
 * unclaimed ranges. A hole keeps the lock alive through the existing lock
 * plus date-range daily rebuild — no parallel recovery system. Lock
 * cleanup requires both empty. A completed legacy lock without claim data is
 * re-covered by the date-range summary before cleanup.
 */
export function catchupNeeded(state: SleepState): string[] {
  const need = failedEssentials(state);
  if (hasUnclaimedRanges(state) && !need.includes("daily-summary")) {
    need.push("daily-summary");
  }
  return need;
}

/** Needed steps in manifest declaration order. The manifest carries no
 *  dependency edges (`requires` holds eligibility predicates), so
 *  declaration order is the contract — no edge DSL. */
export function manifestOrdered(needed: readonly string[]): string[] {
  const order = new Map(loadSleepManifest().map((s, i) => [s.name, i] as const));
  return [...needed].sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999));
}

export interface CatchUpFailure {
  stepId: string;
  reason: SleepModelFailureReason;
  failure: SleepFailure;
}

const MODEL_REASON_CAUSES: Record<SleepModelFailureReason, SleepFailureCause> = {
  provider_failed: "provider_failed",
  provider_timeout: "provider_timeout",
  step_deadline: "step_deadline",
  invalid_response: "invalid_response",
};

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
  const failure = failureFromCatchUpError(err, MODEL_REASON_CAUSES[err.reason]);
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
  const previous = lock.state.steps[stepName];
  lock.state.steps[stepName] = {
    ...previous,
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
      // #1860: an abandoned lock's unclaimed ranges are an explicit loss —
      // recorded (audit log + error report) BEFORE the lock is removed, and
      // only then may those ranges become prunable.
      const explicitLost = unclaimedRanges(lock.state);
      const unknownCoverage = hasUnclaimedRanges(lock.state) && explicitLost.length === 0;
      const dayStart = dateStrToMs(lock.dateStr);
      const lost = unknownCoverage && explicitLost.length === 0
        ? [{ startTs: dayStart, endTs: dayStart + 86400000 - 1 }]
        : explicitLost;
      if (lost.length > 0) {
        const line = `LOSS ${basename(lock.path)} abandoned after ${lock.ageDays}d with ${lost.length} unclaimed range(s): ${formatRanges(lost)} — recovery window (CATCHUP_MAX_AGE_DAYS=${CATCHUP_MAX_AGE_DAYS}) passed`;
        logError(TAG, `[CATCH-UP] ${line}`);
        try {
          writeAuditLog(memoryConfig.memoryDir, {
            timestamp: localISO(),
            model: "catch-up",
            stateSnapshotSummary: `abandoned lock ${basename(lock.path)}, age ${lock.ageDays}d`,
            subagentResponse: line,
            outcomes: { filesConsolidated: 0, messagesPruned: 0, embeddingsRemoved: 0, sessionsCleaned: 0, topicsMerged: 0, topicsDeleted: 0 },
          });
        } catch (err) {
          // Without a durable loss record, keep the lock and stop this cycle;
          // later settlement must not make the range prunable.
          logError(TAG, `[CATCH-UP] Could not persist loss record for ${basename(lock.path)}; retaining lock`);
          throw err;
        }
      } else {
        logError(TAG, `[CATCH-UP] Abandoning stale lock ${basename(lock.path)} — ${lock.ageDays} days old, data unrecoverable`);
      }
      unlinkSync(lock.path);
      continue;
    }

    const needed = catchupNeeded(lock.state);
    if (needed.length === 0) {
      logInfo(TAG, `[CATCH-UP] Cleaning up completed lock ${basename(lock.path)}`);
      unlinkSync(lock.path);
      continue;
    }
    // Manifest declaration order over the needed steps, so a recovered
    // retrospective artifact exists before extraction reads it.
    const ordered = manifestOrdered(needed);

    logInfo(TAG, `[CATCH-UP] ${basename(lock.path)} — recovering: ${needed.join(", ")}`);

    // #1752 R7: an already-completed daily-summary may be reused only through
    // its persisted exact path. Do not reconstruct a path from the lock date.
    let dailySummaryPath: string | null = null;
    const checkpointDailySummary = lock.state.steps["daily-summary"];
    if (checkpointDailySummary?.status === "ok" && !needed.includes("daily-summary")) {
      const checkpointPath = checkpointDailySummary.path;
      if (checkpointPath && readDailyArtifact(checkpointPath).usable) {
        dailySummaryPath = checkpointPath;
      } else {
        // Keep the checkpoint recoverable and surface the dependency defect as
        // its source stage; a stale same-date file is not evidence of success.
        return recordCatchUpFailure(
          lock,
          "daily-summary",
          Date.now(),
          { cause: "unknown", detail: "daily artifact missing or unusable" },
          runId,
          onEvent,
        );
      }
    }

    // 04a — daily summary with date-range
    if (needed.includes("daily-summary")) {
      const start = Date.now();
      try {
        const ctxWindow = getAbmindEnv().sleepCtxWindow;
        const userId = sleepData.getPrimaryUserId();
        const dayStart = dateStrToMs(lock.dateStr);
        const dayEnd = dayStart + 86400000;
        // #1611: catch-up establishes a fresh logical deadline per step; the
        // underlying step's budget applies (catch-up- prefix is stripped).
        const deadlineAt = Date.now() + sleepStepDeadlineMs("catch-up-daily-summary");
        // #1884: execution lives in shared-execution.ts; this wrapper keeps
        // the recovery route's historical window, lock state, and failure policy.
        const outcome = await runSharedDailySummary({
          db: sleepData.getDb(),
          ctxWindow,
          memoryDir: memoryConfig.memoryDir,
          userId,
          window: { kind: "dateRange", startTs: dayStart, endTs: dayEnd },
          send: (p) => sendToRuntime(runtime, p, "catch-up-daily-summary", runId, signal, deadlineAt, budget, retryDelays).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }),
          assertPrincipal: (u) => sleepData.assertWritePrincipal(u),
        });
        if (outcome.kind === "modelFailure") {
          // #1611/#1752: return the typed failure to the orchestrator. A
          // catch-up error must not escape as a generic service failure, or
          // the final report loses its stage/cause and resumability.
          return recordModelFailure(lock, "daily-summary", start, outcome.error as { reason: SleepModelFailureReason; failure?: SleepFailure; message: string }, runId, onEvent);
        }
        if (outcome.kind === "failed") {
          return recordCatchUpFailure(lock, "daily-summary", start, failureFromCatchUpError(outcome.error), runId, onEvent);
        }
        if (outcome.kind === "ok") {
          dailySummaryPath = outcome.path;
          lock.state.steps["daily-summary"] = { status: "ok", essential: true, duration: Math.round((Date.now() - start) / 100) / 10, path: dailySummaryPath, claims: outcome.claims };
        } else {
          dailySummaryPath = null;
          lock.state.steps["daily-summary"] = { status: "skipped", essential: true };
        }
        logInfo(TAG, `[CATCH-UP] ${outcome.kind === "ok" ? "✓" : "⏭"} daily-summary for ${lock.dateStr} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
        emitSleepEvent(onEvent, { type: outcome.kind === "ok" ? "step_completed" : "step_skipped", runId, step: stepSummary("daily-summary", outcome.kind === "ok" ? "completed" : "skipped", Date.now() - start) });
      } catch (err) {
        if (isSleepModelFailure(err)) {
          return recordModelFailure(lock, "daily-summary", start, err as { reason: SleepModelFailureReason; failure?: SleepFailure; message: string }, runId, onEvent);
        }
        return recordCatchUpFailure(lock, "daily-summary", start, failureFromCatchUpError(err), runId, onEvent);
      }
      writeStateFile(lock.path, lock.state);
    }

    if (signal.aborted) return null;

    // Prompt-driven essentials in manifest declaration order — #1752 R7:
    // each requires the daily artifact. Retrospective (03) runs before
    // extract-memories (04) so extraction reads an artifact that already
    // contains the recovered retrospective.
    for (const stepName of ordered) {
      if (stepName === "daily-summary" || stepName === "extract-memories") continue;
      // #1864: consolidation due decisions are evaluated against the current
      // run's cadence state, never a recovered lock's historical date. A
      // catch-up replay must not dispatch it by lock date; the normal step
      // path republishes any due period.
      if (stepName === "consolidation") {
        logInfo(TAG, `[CATCH-UP] ⏭ consolidation for ${lock.dateStr} — cadence is evaluated on the current run, not replayed by lock date`);
        lock.state.steps[stepName] = { status: "skipped", essential: true };
        writeStateFile(lock.path, lock.state);
        emitSleepEvent(onEvent, { type: "step_skipped", runId, step: stepSummary(stepName, "skipped") });
        continue;
      }
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
      const dailyPath = dailySummaryPath;
      // If daily artifact missing/unusable, skip retrospective and leave daily-summary for review/catch-up
      if (!dailyPath) {
        logInfo(TAG, `[CATCH-UP] ⏭ ${stepName} for ${lock.dateStr} — no daily file, skipping`);
        lock.state.steps[stepName] = { status: "skipped", essential: true };
        writeStateFile(lock.path, lock.state);
        emitSleepEvent(onEvent, { type: "step_skipped", runId, step: stepSummary(stepName, "skipped") });
        continue;
      }
      const artifact = readDailyArtifact(dailyPath);
      if (!artifact.usable) {
        logWarn(TAG, `[CATCH-UP] ⏭ ${stepName} for ${lock.dateStr} — daily artifact unusable, skipping`);
        lock.state.steps[stepName] = { status: "skipped", essential: true };
        writeStateFile(lock.path, lock.state);
        emitSleepEvent(onEvent, { type: "step_skipped", runId, step: stepSummary(stepName, "skipped") });
        continue;
      }
      const retrospectiveBeforeContent = readDailyArtifactRaw(dailyPath);
      if (retrospectiveBeforeContent === null) {
        logWarn(TAG, `[CATCH-UP] ⏭ ${stepName} for ${lock.dateStr} — daily artifact became unreadable, skipping`);
        lock.state.steps[stepName] = { status: "skipped", essential: true };
        writeStateFile(lock.path, lock.state);
        emitSleepEvent(onEvent, { type: "step_skipped", runId, step: stepSummary(stepName, "skipped") });
        continue;
      }
      const start = Date.now();
      const deadlineAt = Date.now() + sleepStepDeadlineMs(`catch-up-${stepName}`);
      // #1807: catch-up renders through the shared preparation boundary with
      // the lock's historical date — never today's messages. CLEAN_MESSAGES
      // comes from the existing historical date-range query; DAILY/RETRO paths
      // are the lock's exact artifact. Unresolvable inputs fail preparation,
      // not the provider.
      const histDayStart = dateStrToMs(lock.dateStr);
      const histMsgs = readMessagesByDateRange(sleepData.getDb(), sleepData.getPrimaryUserId(), histDayStart, histDayStart + 86400000)
        .filter(m => !m.content.startsWith("[SYSTEM"));
      const catchupVars: Record<string, string> = {
        DAILY_PATH: dailyPath,
        RETRO_PATH: dailyPath,
        CLEAN_MESSAGES: histMsgs.length > 0
          ? `${histMsgs.length} messages on ${lock.dateStr}:\n\n${histMsgs.map(m => `[${m.role}] ${m.content.slice(0, 500)}`).join("\n")}`
          : `No messages on ${lock.dateStr}.`,
      };
      const prepared = prepareStepDispatch(stepName, step.rawPrompt, catchupVars);
      if (prepared.status !== "ready") {
        const detail = prepared.status === "no_work" ? prepared.reason : prepared.detail;
        logWarn(TAG, `[CATCH-UP] ${stepName} for ${lock.dateStr} — preparation failed: ${detail}`);
        return recordCatchUpFailure(lock, stepName, start, { cause: "service_failed", detail }, runId, onEvent);
      }
      const rawPrompt = prepared.prompt;
      // #1884: retrospective execution lives in shared-execution.ts; other
      // configured-essential prompt steps keep the existing generic fallback
      // below with its current dispatch, preparation, artifact acceptance,
      // and terminal rules.
      if (stepName === "retrospective") {
        const outcome = await runSharedRetrospective({
          dailyPath,
          beforeContent: retrospectiveBeforeContent,
          prompt: rawPrompt,
          send: (p) => sendToRuntime(runtime, p, `catch-up-${stepName}`, runId, signal, deadlineAt, budget, retryDelays),
        });
        if (outcome.kind === "okArtifact") {
          // #1752 R9: the throw and empty-string probes share the acceptance
          // but keep their distinct log lines.
          if (outcome.source === "empty") {
            logInfo(TAG, `[CATCH-UP] ${stepName} empty but artifact was appended — marking ok per R9`);
          } else {
            logInfo(TAG, `[CATCH-UP] ${stepName} empty but artifact was appended (${dailyPath}) — marking ok per R9`);
          }
          lock.state.steps[stepName] = { status: "ok", essential: true, duration: Math.round((Date.now() - start) / 100) / 10 };
          writeStateFile(lock.path, lock.state);
          emitSleepEvent(onEvent, { type: "step_completed", runId, step: stepSummary(stepName, "completed", Date.now() - start) });
          continue;
        }
        if (outcome.kind === "okResponse") {
          lock.state.steps[stepName] = { status: "ok", essential: true, duration: Math.round((Date.now() - start) / 100) / 10 };
          logInfo(TAG, `[CATCH-UP] ✓ ${stepName} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
          emitSleepEvent(onEvent, { type: "step_completed", runId, step: stepSummary(stepName, "completed", Date.now() - start) });
          writeStateFile(lock.path, lock.state);
          continue;
        }
        if (outcome.kind === "modelFailure") {
          // #1752 R11: invalid_response on non-essential catch-up would continue, but retrospective is essential — keep terminal
          return recordModelFailure(lock, stepName, start, outcome.error as { reason: SleepModelFailureReason; failure?: SleepFailure; message: string }, runId, onEvent);
        }
        if (outcome.kind === "failed") {
          return recordCatchUpFailure(lock, stepName, start, failureFromCatchUpError(outcome.error), runId, onEvent);
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
      let response: string | null;
      try {
        response = await sendToRuntime(runtime, rawPrompt, `catch-up-${stepName}`, runId, signal, deadlineAt, budget, retryDelays);
      } catch (err) {
        if (isSleepModelFailure(err)) {
          // #1752 R9: retrospective empty but artifact present — don't fail for missing closing prose (catch-up)
          if ((err as { reason?: string }).reason === "invalid_response") {
            if (hasAppendedDailyArtifact(dailyPath, retrospectiveBeforeContent)) {
              logInfo(TAG, `[CATCH-UP] ${stepName} empty but artifact was appended (${dailyPath}) — marking ok per R9`);
              lock.state.steps[stepName] = { status: "ok", essential: true, duration: Math.round((Date.now() - start) / 100) / 10 };
              writeStateFile(lock.path, lock.state);
              emitSleepEvent(onEvent, { type: "step_completed", runId, step: stepSummary(stepName, "completed", Date.now() - start) });
              continue;
            }
          }
          // #1752 R11: invalid_response on non-essential catch-up would continue, but retrospective is essential — keep terminal
          return recordModelFailure(lock, stepName, start, err as { reason: SleepModelFailureReason; failure?: SleepFailure; message: string }, runId, onEvent);
        }
        return recordCatchUpFailure(lock, stepName, start, failureFromCatchUpError(err), runId, onEvent);
      }
      if (response) {
        lock.state.steps[stepName] = { status: "ok", essential: true, duration: Math.round((Date.now() - start) / 100) / 10 };
        logInfo(TAG, `[CATCH-UP] ✓ ${stepName} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
        emitSleepEvent(onEvent, { type: "step_completed", runId, step: stepSummary(stepName, "completed", Date.now() - start) });
      } else {
        if (response === "") {
          if (hasAppendedDailyArtifact(dailyPath, retrospectiveBeforeContent)) {
            logInfo(TAG, `[CATCH-UP] ${stepName} empty but artifact was appended — marking ok per R9`);
            lock.state.steps[stepName] = { status: "ok", essential: true, duration: Math.round((Date.now() - start) / 100) / 10 };
            writeStateFile(lock.path, lock.state);
            emitSleepEvent(onEvent, { type: "step_completed", runId, step: stepSummary(stepName, "completed", Date.now() - start) });
            continue;
          }
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

    if (signal.aborted) return null;

    // Extract memories from daily — runs AFTER the prompt-driven essentials
    // in manifest order, so it reads an artifact already containing the
    // recovered retrospective. A step already `ok` is not re-run. #1859:
    // catch-up uses the same proposal contract and per-message disposition
    // gating as the normal extraction step.
    if (ordered.includes("extract-memories")) {
      const dailyPath = dailySummaryPath;
      if (!dailyPath || !readDailyArtifact(dailyPath).usable) {
        logInfo(TAG, `[CATCH-UP] ⏭ extract-memories — no daily file for ${lock.dateStr}`);
        lock.state.steps["extract-memories"] = { status: "skipped", essential: true };
        emitSleepEvent(onEvent, { type: "step_skipped", runId, step: stepSummary("extract-memories", "skipped") });
      } else {
        const start = Date.now();
        const userId = sleepData.getPrimaryUserId();
        const dayStart = dateStrToMs(lock.dateStr);
        const dayEnd = dayStart + 86_400_000;
        const dailyContent = (readDailyArtifactRaw(dailyPath) ?? "").slice(0, 20_000);
        const deadlineAt = Date.now() + sleepStepDeadlineMs("catch-up-extract-memories");
        // #1884: execution lives in shared-execution.ts; this wrapper keeps
        // the recovery route's historical window, lock state, and failure
        // policy. The dayStart - 1 lower bound is preserved as-is.
        const outcome = await runSharedExtraction({
          db: sleepData.getDb(),
          sleepData,
          memoryDir: memoryConfig.memoryDir,
          userId,
          windowStartTs: dayStart - 1,
          windowEndTs: dayEnd,
          dailyContent,
          stepId: "catch-up-extract-memories",
          runId,
          priorRunId: lock.state.runId ?? null,
          send: (p) => sendToRuntime(runtime, p, "catch-up-extract-memories", runId, signal, deadlineAt, budget, retryDelays, undefined, { proposalOnly: true }).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }),
        });
        if (outcome.kind === "modelFailure") {
          return recordModelFailure(lock, "extract-memories", start, outcome.error as { reason: SleepModelFailureReason; failure?: SleepFailure; message: string }, runId, onEvent);
        }
        if (outcome.kind === "failed") {
          return recordCatchUpFailure(lock, "extract-memories", start, failureFromCatchUpError(outcome.error), runId, onEvent);
        }
        if (outcome.kind === "incomplete") {
          const detail = outcome.budgetExhausted
            ? `catch-up extraction budget exhausted for ${lock.dateStr} — unoffered messages remain unhandled`
            : `catch-up offered messages without a disposition: ${outcome.unhandled.slice(0, 10).join(",")}`;
          return recordCatchUpFailure(lock, "extract-memories", start, { cause: "service_failed", detail }, runId, onEvent);
        }
        if (outcome.kind === "skipped") {
          lock.state.steps["extract-memories"] = { status: "skipped", essential: true };
          emitSleepEvent(onEvent, { type: "step_skipped", runId, step: stepSummary("extract-memories", "skipped") });
        } else {
          lock.state.steps["extract-memories"] = { status: "ok", essential: true, duration: Math.round((Date.now() - start) / 100) / 10 };
          logInfo(TAG, `[CATCH-UP] ✓ extract-memories for ${lock.dateStr} (${((Date.now() - start) / 1000).toFixed(1)}s) — ${outcome.settledCount} message(s) settled`);
          emitSleepEvent(onEvent, { type: "step_completed", runId, step: stepSummary("extract-memories", "completed", Date.now() - start) });
        }
      }
      writeStateFile(lock.path, lock.state);
    }

    // Final check — cleanup requires failed essentials AND unclaimed ranges
    // both empty; a hole alone keeps the lock for the next catch-up.
    const stillFailing = catchupNeeded(lock.state);
    if (stillFailing.length === 0) {
      logInfo(TAG, `[CATCH-UP] ✅ ${basename(lock.path)} — all essentials recovered, lock deleted`);
      unlinkSync(lock.path);
    } else {
      logWarn(TAG, `[CATCH-UP] ${basename(lock.path)} — still failing: ${stillFailing.join(", ")} (failing ${lock.ageDays} day(s))`);
      if (hasUnclaimedRanges(lock.state)) {
        const holes = unclaimedRanges(lock.state);
        return recordCatchUpFailure(
          lock,
          "daily-summary",
          Date.now(),
          { cause: "invalid_response", detail: `catch-up retained ${holes.length} unclaimed range(s): ${formatRanges(holes) || "coverage is unknown"}` },
          runId,
          onEvent,
        );
      }
    }
  }
  return null;
}
