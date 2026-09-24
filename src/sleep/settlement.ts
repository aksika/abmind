/**
 * settlement.ts — post-loop run settlement (#1838 Part 2a).
 *
 * Single-entry, single-exit sequence moved verbatim out of runSleepCycle:
 * deterministic review → clarification questions → watermark/lock gate →
 * audit → GC/wired flush → result projection + cycle_finished. Post-loop
 * order is preserved exactly.
 *
 * Called only when the run was not cancelled: the orchestrator returns the
 * cancelled projection before this point, so the two `!cancelled` guards from
 * the inline code are structurally true here and not repeated.
 */

import { join } from "node:path";
import type Database from "better-sqlite3";
import { localISO } from "../local-time.js";
import { getMemoryDb } from "../memory-manager.js";
import type { MemoryManager } from "../memory-manager.js";
import type { SleepDataAccess } from "../sleep-data-access.js";
import type { StateSnapshot } from "../sleep-state-gatherer.js";
import { DreamQuestionStore } from "../dream-question-store.js";
import { readDailyArtifact } from "./sleep-extract-daily.js";
import { logInfo, logWarn } from "../mem-logger.js";
import { writeStateFile, formatWiredResults } from "./state.js";
import type { SleepState, WiredResults } from "./state.js";
import { buildSnapshotSummary, writeAuditLog } from "./audit.js";
import { failedEssentials } from "./catchup.js";
import { readGcMarks, writeGcMarks, withGcLock } from "./gc-codec.js";
import type { GcMarks } from "./gc-codec.js";
import { LlmBudget } from "./llm-budget.js";
import type { SleepModelFailureReason } from "./llm-budget.js";
import { emitSleepEvent } from "./contracts.js";
import type {
  SleepRunOptions,
  SleepRunResult,
  SleepTerminalStatus,
  SleepFailure,
} from "./contracts.js";
import { metaSet, metaGetInt } from "../meta-store.js";
import { toBoundedFailure } from "./failure-report.js";
import { processAskCandidates } from "./ask-candidates.js";
import { evaluateSleepReview, countNonObservationExtractions } from "./review.js";
import { projectResult } from "./result.js";

const TAG = "abmind-sleep";

/** Explicit narrow input to the settlement sequence. */
export interface SettlementInput {
  runId: string;
  state: SleepState;
  statePath: string;
  /** Run-local per-step budget attribution; a fresh reader is built when absent. */
  budget: LlmBudget | undefined;
  /** Captured before daily-summary reads messages; never recomputed here. */
  watermarkTargetTs: number;
  memory: MemoryManager;
  sleepData: SleepDataAccess;
  db: Database.Database;
  /** Validated current-cycle GC selection; never reconstructed from all marks. */
  gcCycleSelection: number[] | null;
  /** Run-local GC diagnostic set before the loop; first report wins. */
  gcDiagnostic: string | null;
  onEvent: SleepRunOptions["onEvent"];
  snapshot: StateSnapshot;
  vars: Record<string, string>;
  primaryUserId: string;
  modelUsed: string;
  memoryDir: string;
  wiredResults: WiredResults;
  terminalModelFailure: { stepId: string; reason: SleepModelFailureReason; failure: SleepFailure } | null;
  newEvidenceRevisions: ReadonlyMap<number, number>;
  existingEvidenceRevisions: ReadonlyMap<number, number>;
  currentRunNewIds: ReadonlySet<number>;
  acceptedOutputChars: ReadonlyMap<string, number>;
  stepOrder: readonly string[];
  now: () => number;
  signal: AbortSignal;
  startedAt: number;
}

export async function settleSleepRun(input: SettlementInput): Promise<SleepRunResult> {
  const {
    runId, state, statePath, budget, watermarkTargetTs, memory, sleepData, db,
    gcCycleSelection, onEvent, snapshot, vars, primaryUserId, modelUsed, memoryDir,
    wiredResults, terminalModelFailure, newEvidenceRevisions, existingEvidenceRevisions,
    currentRunNewIds, acceptedOutputChars, stepOrder, now, signal, startedAt,
  } = input;
  // #1807: run-local GC diagnostic continues here — the pre-loop finding wins,
  // a flush-time incompatible artifact only reports when nothing did yet.
  let gcDiagnostic = input.gcDiagnostic;
  const noteGcIncompatible = (detail: string): void => {
    if (!gcDiagnostic) {
      gcDiagnostic = `GC artifact ${join(memoryDir, "garbage.json")} is incompatibly shaped (${detail}) — left unchanged, no GC deletion authorized; operator reconciliation required.`;
      logWarn(TAG, `[SLEEP] ${gcDiagnostic}`);
    }
  };

  // ── #1653: deterministic pre-settlement review ─────────────────────────
  // Runs after the step loop and BEFORE lock settlement, watermark
  // advancement, garbage deletion, and old-message flushing. It is a veto on
  // destructive progress: downgrades are persisted to the lock first, then
  // settlement recomputes its existing gates from the reviewed state. The
  // review makes no LLM call, consumes no budget, and never rewrites
  // failed/timeout steps — only `ok -> failed`.
  let reviewLine: string | null = null;
  try {
    const budgetForReview = budget ?? new LlmBudget(state, statePath);
    // One captured review instant — the extraction count query and the
    // judgment share it so the window is stable for the whole review.
    const reviewedAtTs = now();
    const dailySummaryStep = state.steps["daily-summary"];
    const dailyArtifactUsable = dailySummaryStep?.status === "ok"
      ? typeof dailySummaryStep.path === "string" && dailySummaryStep.path.length > 0
        ? readDailyArtifact(dailySummaryStep.path).usable
        : false
      : null;

    const extractionRelevant =
      state.steps["extract-memories"]?.status === "ok"
      && budgetForReview.callsFor("extract-memories") > 0
      && snapshot.dbStats.messagesSinceLastSleep > 0;
    const extractedMemoryCount = extractionRelevant
      ? countNonObservationExtractions(memory, primaryUserId, state.startedAt, reviewedAtTs)
      : null;

    const findings = evaluateSleepReview(
      state,
      {
        bufferedMessageCount: snapshot.dbStats.messagesSinceLastSleep,
        extractedMemoryCount,
        stepCalls: (stepId) => budgetForReview.callsFor(stepId),
        acceptedOutputChars,
        dailyArtifactUsable,
      },
      stepOrder,
    );

    let applied = false;
    for (const f of findings) {
      if (!f.downgrade) continue;
      const s = state.steps[f.stepId];
      if (s?.status === "ok") {
        s.status = "failed";
        s.failure = toBoundedFailure("unknown", f.detail);
        applied = true;
      }
    }
    const downgrades = findings.filter(f => f.downgrade);
    if (applied) {
      logWarn(TAG, `[REVIEW] Degraded ${downgrades.map(f => f.stepId).join(", ")} — run requires resume`);
      // Persist the reviewed state BEFORE settlement recomputes its gates.
      writeStateFile(statePath, state);
    }
    if (downgrades.length > 0) {
      reviewLine = `Review degraded — ${downgrades.map(f => `${f.stepId}: ${f.detail}`).join("; ")}.`;
    }
  } catch (err) {
    // The review is bounded and deterministic; a failure here must never
    // block settlement — it simply means no degradation was applied.
    logWarn(TAG, `[REVIEW] skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── #1515: persist authorized step-05 clarification candidates ─────────
  // Runs AFTER the #1653 downgrades and BEFORE terminal settlement. Step 05
  // must still be `ok` with a retained response — skipped, failed,
  // downgraded, cancelled, and terminally failed runs create no rows. The
  // whole block is isolated: a candidate, evidence, or store failure never
  // rewrites step status, report, watermark, lock settlement, or flushing.
  try {
    const memDb = getMemoryDb(memory);
    if (memDb) {
      const questionStore = new DreamQuestionStore(memDb, { now });
      // Reconcile the owner's active/terminal rows at every non-cancelled
      // sleep boundary, not only when step 05 happens to emit an ASK line.
      // Bounded reads repeat this pass before returning data.
      questionStore.reconcile(primaryUserId, now());

      const step05Ok = state.steps["contradiction-and-graph"]?.status === "ok";
      const retained = vars.CONTRADICTION_AND_GRAPH_OUTPUT;
      // A later terminal model failure makes the assembled run untrustworthy
      // too.  Do not persist a question from step 05 when settlement will
      // report the run as failed and resumable.
      if (!terminalModelFailure && step05Ok && typeof retained === "string" && retained.length > 0) {
        const accepted = processAskCandidates({
          response: retained,
          questionStore,
          memDb,
          userId: primaryUserId,
          runId,
          newEvidenceRevisions,
          existingEvidenceRevisions,
          currentRunNewIds,
        });
        if (accepted > 0) logInfo(TAG, `[QUESTIONS] Accepted ${accepted} clarification question(s)`);
      }
    }
  } catch (err) {
    logWarn(TAG, `[QUESTIONS] candidate review skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // #1603: the gate for the lock status, the watermark, and the garbage
  // flush is "no essential step failed" — a non-essential step's failure
  // must not freeze the memory pipeline.
  const essentialsOk = failedEssentials(state).length === 0;

  // Set final status. #1611: a terminal model failure is an explicit
  // final-status input, independent of essential membership — the sleep
  // stops without fallback and never reports partial.
  if (state.status === "ongoing") {
    state.status = terminalModelFailure || !essentialsOk ? "failed" : "completed";
    writeStateFile(statePath, state);
  }

  // Checkpoint boundary: before watermark advance.
  let watermarkAdvanced = false;
  if (essentialsOk && !terminalModelFailure && !signal.aborted) {
    try {
      const count = sleepData.advanceExtractionWatermarks(watermarkTargetTs);
      watermarkAdvanced = count > 0;
      logInfo(TAG, `[SLEEP] Extraction watermark advanced for ${count} chat(s)`);
    } catch { /* non-fatal */ }
  } else if (!essentialsOk || terminalModelFailure) {
    logWarn(TAG, "[SLEEP] Watermark NOT advanced — essential steps failed, messages preserved for catch-up");
  }

  const stepEntries = Object.entries(state.steps);
  const okCount = stepEntries.filter(([, s]) => s.status === "ok").length;
  const failCount = stepEntries.filter(([, s]) => s.status === "failed" || s.status === "timeout").length;
  const skipCount = stepEntries.filter(([, s]) => s.status === "skipped").length;
  const totalDuration = (Date.now() - state.startedAt) / 1000;

  const allResponses = stepEntries.map(([k, v]) => `[${k}] ${v.status}${v.duration ? ` (${v.duration}s)` : ""}`).join("\n");
  try {
    writeAuditLog(memoryDir, {
      timestamp: localISO(),
      model: modelUsed,
      stateSnapshotSummary: buildSnapshotSummary(snapshot),
      subagentResponse: `Wired: ${formatWiredResults(wiredResults)}\n${allResponses}${vars.RETRO_CONTENT ? "\n\n--- Retrospective ---\n" + vars.RETRO_CONTENT : ""}`,
      outcomes: { filesConsolidated: 0, messagesPruned: wiredResults.purged + wiredResults.deduped, embeddingsRemoved: 0, sessionsCleaned: 0, topicsMerged: 0, topicsDeleted: 0 },
    });
  } catch (err) {
    process.stderr.write(`Warning: Failed to write audit — ${err instanceof Error ? err.message : String(err)}\n`);
  }

  if (essentialsOk && !terminalModelFailure) {
    try {
      // #1807: immediate post-success flushing uses only the current-cycle
      // validated selection. Older marks stay for the seven-day maintenance
      // path; an incompatible artifact fails closed (diagnostic, no flush).
      if (gcCycleSelection && gcCycleSelection.length > 0) {
        await withGcLock(memoryDir, () => {
          const status = readGcMarks(memoryDir);
          if (status.kind !== "ok") {
            if (status.kind === "incompatible") noteGcIncompatible(status.detail);
            return;
          }
          const remaining: GcMarks = new Map(status.marks);
          const flushed = gcCycleSelection!.filter((id) => remaining.has(id));
          sleepData.deleteMessagesByIds(flushed);
          for (const id of flushed) remaining.delete(id);
          writeGcMarks(memoryDir, remaining);
          if (flushed.length > 0) logInfo(TAG, `[SLEEP] Flushed ${flushed.length} garbage messages`);
        });
      }
      const { agedOut, capped } = sleepData.flushOldMessages({ maxAgeDays: 7, maxCount: 500 });
      if (agedOut > 0) logInfo(TAG, `[SLEEP] Flushed ${agedOut} messages >7d`);
      if (capped > 0) logInfo(TAG, `[SLEEP] Flushed ${capped} messages (cap 500)`);
    } catch (err) { logWarn(TAG, `[WIRED] flush failed: ${err instanceof Error ? err.message : String(err)}`); }
  }

  logInfo(TAG, `[SLEEP] 🏁 ${okCount} ok, ${failCount} failed, ${skipCount} skipped | wired: ${formatWiredResults(wiredResults)} | ${totalDuration.toFixed(0)}s total`);

  // A terminal catch-up failure is represented separately from the current
  // run's step map, so failCount can still be zero. It must nevertheless
  // count as a failed cycle; otherwise the success timestamp would advance
  // while the older checkpoint remains unrecovered.
  if (failCount === 0 && !terminalModelFailure) {
    metaSet(db, "sleep_last_success_ts", Date.now());
    metaSet(db, "sleep_consecutive_failures", 0);
  } else {
    const prev = metaGetInt(db, "sleep_consecutive_failures") ?? 0;
    metaSet(db, "sleep_consecutive_failures", prev + 1);
    metaSet(db, "sleep_last_fail_reason", `${failCount} step(s) failed`);
  }

  const terminalStatus: SleepTerminalStatus =
    terminalModelFailure ? "failed"
    : failCount === 0 ? "completed"
    : failedEssentials(state).length > 0 ? "failed"
    : "partial";
  // #1653: failed/timeout steps and reviewer downgrades request the existing
  // resume path — a partial run with a failed non-essential step is
  // resumable, and downgrades are resumable by definition. failCount covers
  // both (a downgrade rewrites the step to failed).
  const resumable = failedEssentials(state).length > 0 || terminalModelFailure !== null || failCount > 0;
  const result = projectResult(runId, terminalStatus, startedAt, now(), state, watermarkAdvanced, resumable, terminalModelFailure, reviewLine, gcDiagnostic);
  emitSleepEvent(onEvent, { type: "cycle_finished", runId, result });
  return result;
}
