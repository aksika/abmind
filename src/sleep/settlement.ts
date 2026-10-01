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
import { parseNumberEnv } from "../mem-env.js";
import { writeStateFile, formatWiredResults } from "./state.js";
import type { SleepState, WiredResults } from "./state.js";
import { buildSnapshotSummary, writeAuditLog } from "./audit.js";
import { failedEssentials } from "./sleep-manifest.js";
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
import { coverageCeilingTs, unclaimedRanges, formatRanges, CONSUMED_SESSION_SQL } from "./coverage.js";
import { processAskCandidates } from "./ask-candidates.js";
import { evaluateSleepReview, countNonObservationExtractions } from "./review.js";
import { projectResult } from "./result.js";
import { readReceipts } from "./receipts.js";
import { summarizeSleepJudgments } from "../sleep-judgment.js";
import type { SleepJudgmentSummary } from "../sleep-judgment.js";
import { readJudgmentRecords } from "./judgment-records.js";

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
  /** #1817: per-run advisory judgment activity for the run report. Absent
   *  unless SYSTEM1_SLEEP was on; the line still counts annotations and
   *  records read from disk. */
  sleepJudgments?: SleepJudgmentSummary | null;
}

/** #1859: receipted extraction dispositions (accepted/declined/dropped) for
 *  the extraction step. A dispositioned message is handled even when no row
 *  was stored; the step itself already fails on missing dispositions, so
 *  this only prevents the #1653 write-count review from re-failing an
 *  honestly all-declined extraction. */
function countHandledExtractionReceipts(memoryDir: string, runId: string): number {
  try {
    return readReceipts(memoryDir, runId)
      .filter(r =>
        (r.op === "store" || r.op === "decline" || r.op === "overflow")
        && (r.disposition === "accepted" || r.disposition === "declined" || r.disposition === "dropped"))
      .length;
  } catch {
    return 0;
  }
}

/** Unprunable message volume per principal and scope class (#1860). Includes *  rows held by ownership, session scope, or this run's coverage ceiling,
 *  even when a stale historical watermark is already beyond them. */
function describeRetention(db: Database.Database, userId: string, coveredThroughTs: number | null): string {
  const retentionWatermarkGuard = `m.timestamp <= COALESCE(
    (SELECT w.last_processed_timestamp FROM extraction_watermarks w WHERE w.user_id = m.user_id), 0)`;
  const coveredGuard = coveredThroughTs === null
    ? "0"
    : `(m.user_id = ? AND m.timestamp <= ? AND ${retentionWatermarkGuard} AND ${CONSUMED_SESSION_SQL})`;
  const systemExclusionGuard = `(m.content LIKE '[SYSTEM%' AND ${retentionWatermarkGuard})`;
  const rows = db.prepare(
    `SELECT m.user_id AS userId,
       SUM(CASE WHEN ${CONSUMED_SESSION_SQL} THEN 1 ELSE 0 END) AS consumed,
       SUM(CASE WHEN ${CONSUMED_SESSION_SQL} THEN 0 ELSE 1 END) AS otherScope
     FROM messages m
     WHERE NOT (${coveredGuard} OR ${systemExclusionGuard})
     GROUP BY m.user_id`,
  ).all(...(coveredThroughTs === null ? [] : [userId, coveredThroughTs])) as Array<{ userId: string; consumed: number; otherScope: number }>;
  return rows
    .map(r => `${r.userId}/consumed=${r.consumed},other-scope=${r.otherScope}`)
    .join("; ");
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
    // #1859: receipted dispositions are themselves the evidence that
    // extraction handled its input; a decline-only extraction is complete.
    // Fall back to them when the run window cannot see the rows (test
    // clocks, skew) so a truthful cross-timestamp write is not misread as
    // "no extraction writes".
    const receiptHandled = countHandledExtractionReceipts(memoryDir, runId);
    const counted = extractionRelevant
      ? countNonObservationExtractions(memory, primaryUserId, state.startedAt, reviewedAtTs)
      : null;
    const extractedMemoryCount = counted !== null && counted === 0 && receiptHandled > 0
      ? receiptHandled
      : counted;

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
  // #1860: claims, not booleans, authorize the advance. The watermark moves
  // to the coverage ceiling — the greatest T ≤ watermarkTargetTs with every
  // consumed-scope message at or below T claimed — and only for the consumed
  // principal. A hole holds the watermark below it; absent claim data
  // (legacy) holds it entirely. Essentials-ok stays a precondition, and the
  // advance stays monotonic (#1603): the predicate can only lower it.
  let watermarkAdvanced = false;
  let coverageLine: string | null = null;
  let coveredThroughTs: number | null = null;
  if (essentialsOk && !terminalModelFailure && !signal.aborted) {
    try {
      const ceiling = coverageCeilingTs(state, primaryUserId, watermarkTargetTs);
      if (ceiling === null) {
        coverageLine = "Coverage: no claim data — watermark held, messages retained for the next normal run";
        logWarn(TAG, `[SLEEP] Watermark NOT advanced — ${coverageLine}`);
      } else {
        coveredThroughTs = ceiling;
        const count = sleepData.advanceExtractionWatermarks(ceiling, primaryUserId);
        watermarkAdvanced = count > 0;
        const holes = unclaimedRanges(state, primaryUserId).filter(h => h.startTs <= watermarkTargetTs);
        coverageLine = `Coverage: watermark → ${new Date(ceiling).toISOString()} (${count} chat(s))`
          + (holes.length > 0 ? `; ${holes.length} hole(s) retained: ${formatRanges(holes)}` : "; contiguous");
        logInfo(TAG, `[SLEEP] Extraction watermark advanced for ${count} chat(s)${holes.length > 0 ? ` with ${holes.length} hole(s) held` : ""}`);
      }
    } catch { /* non-fatal */ }
  } else if (!essentialsOk || terminalModelFailure) {
    logWarn(TAG, "[SLEEP] Watermark NOT advanced — essential steps failed, messages retained for the next normal run");
  }

  // #1860: retained-unclaimed volume per principal and scope. Reported, not
  // pruned: non-consumed principals and session types keep their rows while
  // the count cap stays best-effort over claimable rows.
  let retentionLine: string | null = null;
  try {
    retentionLine = describeRetention(db, primaryUserId, coveredThroughTs);
    if (retentionLine) {
      logInfo(TAG, `[SLEEP] Retained unclaimed — ${retentionLine}`);
      coverageLine = coverageLine ? `${coverageLine}; retained: ${retentionLine}` : `Coverage: retained: ${retentionLine}`;
    }
  } catch { /* reporting must never fail settlement */ }

  // #1859: bounded write-receipt disposition summary for the run report.
  let receiptsLine: string | null = null;
  // #1817: advisory judgment summary for the run report. Null unless the
  // advisory layer produced something observable this run.
  let judgmentsLine: string | null = null;
  try {
    const receipts = readReceipts(memoryDir, runId);
    if (receipts.length > 0) {
      const byDisposition = new Map<string, number>();
      for (const r of receipts) {
        byDisposition.set(r.disposition, (byDisposition.get(r.disposition) ?? 0) + 1);
      }
      const parts = ["accepted", "declined", "dropped", "rejected"]
        .map(d => `${byDisposition.get(d) ?? 0} ${d}`)
        .join(", ");
      receiptsLine = `Write receipts: ${parts}.`;
      const rejected = byDisposition.get("rejected") ?? 0;
      const dropped = byDisposition.get("dropped") ?? 0;
      if (rejected > 0 || dropped > 0) {
        logWarn(TAG, `[SLEEP] ${receiptsLine} Unapplied proposals changed nothing; reasons are in the receipts file.`);
      }
    }
    const records = readJudgmentRecords(memoryDir, runId);
    const gcSelected = gcCycleSelection !== null ? new Set(gcCycleSelection) : null;
    judgmentsLine = summarizeSleepJudgments(receipts, records, input.sleepJudgments ?? null, gcSelected);
  } catch (err) {
    logWarn(TAG, `[SLEEP] receipt summary skipped: ${err instanceof Error ? err.message : String(err)}`);
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
      subagentResponse: `Wired: ${formatWiredResults(wiredResults)}\n${allResponses}${coverageLine ? `\n${coverageLine}` : ""}${vars.RETRO_CONTENT ? "\n\n--- Retrospective ---\n" + vars.RETRO_CONTENT : ""}`,
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
      // #1860: the validated ids are exactly an `excluded` claim — explicit
      // exclusion, so the invariant holds without a coverage lookup.
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
      // Raw-message retention window comes from .env.memory
      // (MEMORY_RAW_RETENTION_DAYS, default 30); the daemon loads the file
      // at startup, so changing it needs a restart. Clamped to >= 1 day —
      // zero/negative would flush everything under coverage.
      const rawRetentionDays = Math.max(1, Math.floor(parseNumberEnv("MEMORY_RAW_RETENTION_DAYS", 30)));
      const { agedOut, capped } = sleepData.flushOldMessages({
        maxAgeDays: rawRetentionDays,
        maxCount: 500,
        userId: primaryUserId,
        coveredThroughTs,
      });
      if (agedOut > 0) logInfo(TAG, `[SLEEP] Flushed ${agedOut} messages >${rawRetentionDays}d`);
      if (capped > 0) logInfo(TAG, `[SLEEP] Flushed ${capped} messages (cap 500)`);
    } catch (err) { logWarn(TAG, `[WIRED] flush failed: ${err instanceof Error ? err.message : String(err)}`); }
  }

  logInfo(TAG, `[SLEEP] 🏁 ${okCount} ok, ${failCount} failed, ${skipCount} skipped | wired: ${formatWiredResults(wiredResults)} | ${totalDuration.toFixed(0)}s total`);

  // A terminal model failure is represented separately from the current
  // run's step map, so failCount can still be zero. It must nevertheless
  // count as a failed cycle; otherwise the success timestamp would advance
  // while unsettled messages remain unrecovered.
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
  const result = projectResult(runId, terminalStatus, startedAt, now(), state, watermarkAdvanced, resumable, terminalModelFailure, reviewLine, gcDiagnostic, coverageLine, receiptsLine, judgmentsLine);
  emitSleepEvent(onEvent, { type: "cycle_finished", runId, result });
  return result;
}
