/**
 * step-units.ts — per-step sleep units (#1838 Part 2b).
 *
 * One unit per step name for the nine code-driven branches, moved out of
 * runSleepCycle's loop body. Each unit prepares its own input, dispatches to
 * the runtime, and returns an explicit outcome; units never write the state
 * file, never decide resumability, and never emit lifecycle events — the loop
 * keeps eligibility, checkpointing, deadline establishment, outcome
 * application (state, events, terminal recording), and flow control.
 *
 * Steps without a domain branch (feedback, memory-maintenance, translation,
 * future manifest entries) flow through the generic prompt unit.
 *
 * Invariants preserved verbatim from the loop body: per-step deadlines are
 * established by the loop and passed in (#1611); R9/R11 classification moves
 * with the units unchanged (#1752); preparation failures keep step-level
 * meaning and never charge a model call (#1807); #1840's cleanup asymmetry is
 * untouched (cancellation wiring stays in the orchestrator).
 */

import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { getAbmindEnv } from "../env-schema.js";
import { getMemoryDb } from "../memory-manager.js";
import type { MemoryManager } from "../memory-manager.js";
import type { SleepDataAccess } from "../sleep-data-access.js";
import { localDate } from "../local-time.js";
import { logInfo, logWarn, logTrace } from "../mem-logger.js";
import { redactSecrets } from "../redact-secrets.js";
import { buildDailySummary, writeDailyFile, LLMUnavailableError } from "../sleep-pipeline.js";
import {
  prepareStepDispatch,
  knowledgeFileInputs,
  knowledgeAvailabilitySection,
  consolidationInputs,
  previousConsolidationSection,
  RETRO_ABSENT_MARKER,
} from "./step-prepare.js";
import { planConsolidation } from "./consolidation-cadence.js";
import type { ConsolidationPlan, ConsolidationTarget } from "./consolidation-cadence.js";
import { hasAppendedDailyArtifact, readDailyArtifact, readDailyArtifactRaw } from "./sleep-extract-daily.js";
import { persistGcSelection } from "./gc-codec.js";
import {
  sendToRuntime,
  isSleepModelFailure,
  type SleepModelFailureError,
  type LlmBudget,
} from "./llm-budget.js";
import type { SleepModelFailureReason } from "./llm-budget.js";
import { sleepStepConfig } from "./sleep-manifest.js";
import { toBoundedFailure, failureFromError } from "./failure-report.js";
import type { SleepFailure, SleepRuntime } from "./contracts.js";
import type { CoverageClaim } from "./coverage.js";
import type { DailySummaryResult } from "./sleep-daily-summary.js";
import {
  applyProposals,
  emptySnapshot,
  isProposalOnlyStep,
  loadAcceptedReceipts,
  parseBracketIds,
  parseHashIds,
  persistProposalReceipts,
  readKnowledgeVersion,
  snapshotRevisions,
  KNOWLEDGE_FILES,
} from "./proposals.js";
import type { ProposalApplyContext, ProposalOp, ProposalSnapshot } from "./proposals.js";
import type { AdvisoryJudge } from "./proposals.js";
import {
  applyExtractionBatch,
  collectOfferedMessages,
  EXTRACTION_BATCH_MESSAGES,
  MAX_EXTRACTION_BATCHES,
  renderExtractionPrompt,
} from "./extraction-proposals.js";
import type { OfferedMessage } from "./extraction-proposals.js";
import { writeReceipts, readReceipts } from "./receipts.js";
import type { WriteReceipt } from "./receipts.js";
import {
  SLEEP_SUPPORT_QUESTION_SET,
  SleepJudgmentRun,
  judgeCandidateSupport,
  judgeGcBatch,
  judgePairs,
  seedMemoFromPriorRun,
  sleepJudgmentConfig,
} from "../sleep-judgment.js";
import type { GcSubject, PairSubject, SleepJudgeDeps } from "../sleep-judgment.js";
import { writeJudgmentRecords } from "./judgment-records.js";
import type { JudgmentRecordEntry } from "./judgment-records.js";

const TAG = "abmind-sleep";

/** Prompt steps that append to the daily-summary artifact. They must never
 * receive a guessed path when daily-summary was skipped or cannot be reused. */
const DAILY_ARTIFACT_STEPS = new Set(["retrospective", "skill-review"]);

/** Mutable run scratch owned by the cycle and shared with its step units. */
export interface StepRunScratch {
  vars: Record<string, string>;
  /** #1653: run-local accepted output length per step (budget_without_output fact). */
  acceptedOutputChars: Map<string, number>;
  dailySummaryPath: string | null;
  retrospectiveBeforeContent: string | null;
  /** #1843: daily artifact content before the skill-review model call. */
  skillReviewBeforeContent: string | null;
  /** #1807: valid IDs shown to the gc-noise model; validated selection for flush. */
  gcValidIds: Set<number> | null;
  gcCycleSelection: number[] | null;
  /** #1515: step-05 evidence snapshots for clarification-candidate authorization. */
  newEvidenceRevisions: Map<number, number>;
  existingEvidenceRevisions: Map<number, number>;
  currentRunNewIds: Set<number>;
  /** #1859: per-invocation bounded candidate snapshot for proposal-only
   *  turns. Set by each fenced step's prepare hook from exactly what was
   *  rendered into its prompt; cleared on every fenced prepare. */
  proposal: import("./proposals.js").ProposalSnapshot | null;
  /** #1859: receipts written by the current step's apply (report/audit). */
  proposalReceipts: WriteReceipt[];
  /** #1817: per-run advisory judgment state (budget + memo), shared across
   *  steps. Absent unless SYSTEM1_SLEEP is on. Optional so existing
   *  fixtures keep compiling. */
  sleepJudgments?: SleepJudgmentRun | null;
  /** #1817: gc message excerpts for advisory triage, set by prepareGc. */
  gcExcerpts?: Map<number, string> | null;
  /** #1864: the due consolidation target prepared for this run — the period,
   *  rendered input list, and prepared source snapshot carried to
   *  publication. Never recomputed between prepare and finish. */
  consolidation: ConsolidationTarget | null;
  /** SOUL prefix consumed once by the first dispatched step. */
  soulPrefix: string;
}

/** Named dependencies for one step invocation. */
export interface StepUnitContext {
  stepName: string;
  rawPrompt: string;
  essential: boolean;
  stepIndex: number;
  stepLogDir: string;
  /** Loop-captured branch entry (Date.now) — the unit's duration base. */
  startMs: number;
  /** #1611: absolute deadline established by the loop before any subcall. */
  stepDeadlineAt: number;
  runtime: SleepRuntime;
  runId: string;
  /** #1353 lineage: the interrupted run this attempt resumes, if any. */
  priorRunId: string | null;
  signal: AbortSignal;
  retryDelays: readonly number[];
  now: () => number;
  budget: LlmBudget;
  sleepData: SleepDataAccess;
  memory: MemoryManager;
  memoryDir: string;
  primaryUserId: string;
  lastSleepTs: number;
  runStartedAt: number;
  /** #1859: window ceiling captured before daily-summary read messages; the
   *  extraction offer never includes messages arriving mid-cycle. */
  watermarkTargetTs: number;
  dailySummaryStatus: string;
  noteGcIncompatible: (detail: string) => void;
  scratch: StepRunScratch;
}

/**
 * Explicit step outcome. Preparation failures keep step-level meaning;
 * terminal outcomes carry the recorder input; aborted surfaces a mid-step
 * cancellation so the loop can persist the suspension marker and stop.
 */
export type StepUnitOutcome =
  | { kind: "ok"; durationS: number; path?: string; promptTail?: { responseChars: number }; resetFailures?: true; claims?: CoverageClaim[] }
  | { kind: "skipped" }
  | { kind: "failed"; durationS: number; failure: SleepFailure; stopWhenEssential: boolean; promptTail?: { responseChars: number } }
  | { kind: "terminal"; elapsedMs: number; reason: SleepModelFailureReason; failure: SleepFailure }
  | { kind: "aborted" };

function durationS(elapsedMs: number): number {
  return Math.round(elapsedMs / 100) / 10;
}

/** #1752 R10: persist bounded per-attempt evidence alongside step logs. No raw prompt. */
function persistEmptyEvidence(stepLogDir: string, stepIndex: number, stepName: string, evidence: unknown[]): void {
  try {
    const capped = evidence.slice(0, 8).map(e => {
      const r = e as Record<string, unknown>;
      const out: Record<string, unknown> = { attempt: r["attempt"], responseLength: r["responseLength"] };
      if (r["outcome"] !== undefined) out["outcome"] = r["outcome"];
      if (r["finishReason"] !== undefined) out["finishReason"] = String(r["finishReason"]).slice(0, 80);
      if (r["promptTokens"] !== undefined) out["promptTokens"] = r["promptTokens"];
      if (r["completionTokens"] !== undefined) out["completionTokens"] = r["completionTokens"];
      if (r["hasReasoning"] !== undefined) out["hasReasoning"] = r["hasReasoning"];
      if (r["hasToolCalls"] !== undefined) out["hasToolCalls"] = r["hasToolCalls"];
      return out;
    });
    const path = join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${stepName}.evidence.json`);
    writeFileSync(path, redactSecrets(JSON.stringify(capped, null, 2)).slice(0, 4000), "utf-8");
    // Trace level also emits text excerpts (capped) — the always-on file is the load-bearing part
    for (const ev of capped) {
      logTrace(TAG, `Evidence ${stepName} attempt ${(ev as { attempt: number }).attempt}: ${JSON.stringify(ev)}`);
    }
  } catch { /* bounded persistence must never fail cycle */ }
}

function recordModelEvidence(ctx: StepUnitContext, err: unknown): void {
  const ev = (err as unknown as { evidence?: unknown[] }).evidence;
  if (ev && Array.isArray(ev) && ev.length > 0) persistEmptyEvidence(ctx.stepLogDir, ctx.stepIndex, ctx.stepName, ev);
}

// ── Advisory sleep judgments (#1817) ─────────────────────────────────────────
// Annotate, never divert: every helper here records verdicts next to the
// baseline outcome and never changes a disposition, selection, or step
// result. All entry points fail open to the unjudged baseline.

/** Resolve the per-step advisory handle, or null when SYSTEM1_SLEEP is off.
 *  The run state (budget + memo) is created once per cycle on the scratch
 *  and shared across steps; a resumed run seeds its memo from the prior
 *  run's receipts and records. */
function advisoryForStep(ctx: StepUnitContext): { run: SleepJudgmentRun; deps: SleepJudgeDeps; judge: AdvisoryJudge } | null {
  const config = sleepJudgmentConfig();
  if (!config.enabled) return null;
  const existing = ctx.scratch.sleepJudgments ?? null;
  const active: SleepJudgmentRun = existing ?? new SleepJudgmentRun(config.limits, ctx.now() + config.limits.budgetMs);
  if (existing === null) {
    seedMemoFromPriorRun(active, ctx.memoryDir, ctx.priorRunId);
    ctx.scratch.sleepJudgments = active;
  }
  const deps: SleepJudgeDeps = {
    provider: ctx.memory.getJudgmentProvider(),
    timeoutMs: config.timeoutMs,
    questionSet: SLEEP_SUPPORT_QUESTION_SET,
    signal: ctx.signal,
  };
  const now = ctx.now;
  return { run: active, deps, judge: (subject) => judgeCandidateSupport(deps, active, subject.opId, subject.claim, subject.evidence, now()) };
}

/** Persist advisory verdicts. A persistence loss is logged and counted —
 *  it never fails the step, because advisory data is auxiliary. */
function recordAdvisory(ctx: StepUnitContext, entries: JudgmentRecordEntry[]): void {
  if (entries.length === 0) return;
  const lost = writeJudgmentRecords(ctx.memoryDir, entries);
  if (lost > 0) {
    logWarn(TAG, `[SLEEP] ${ctx.stepName} — ${lost} advisory verdict(s) lost (record persistence failed); baseline unaffected`);
  }
}

/** #1817 advisory gc-noise triage. Records keep/noise verdicts and keeps
 *  every message: the code-owned selection above already decided. */
async function advisoryGcTriage(ctx: StepUnitContext): Promise<void> {
  const advisory = advisoryForStep(ctx);
  const excerpts = ctx.scratch.gcExcerpts;
  if (advisory === null || !excerpts || excerpts.size === 0) return;
  try {
    const items: GcSubject[] = [...excerpts].map(([id, excerpt]) => ({ id, excerpt }));
    const verdicts = await judgeGcBatch(advisory.deps, advisory.run, items, ctx.now());
    const at = ctx.now();
    const model = advisory.deps.provider?.model ?? "none";
    const entries: JudgmentRecordEntry[] = [];
    for (const [id, v] of verdicts) {
      entries.push({
        runId: ctx.runId, step: ctx.stepName, principal: ctx.primaryUserId,
        gate: "gc-noise", subject: `msg:${id}`, decision: v.decision,
        verdict: v.verdict, questionSet: SLEEP_SUPPORT_QUESTION_SET,
        model, reason: v.reason, at,
      });
    }
    recordAdvisory(ctx, entries);
  } catch (err) {
    // Advisory only: the selection already persisted; keep everything.
    logWarn(TAG, `[SLEEP] ${ctx.stepName} — advisory gc triage failed (${err instanceof Error ? err.message : String(err)}); messages kept`);
  }
}

/** #1817 advisory contradiction/maintenance pre-triage over the snapshot's
 *  shown pairs. The full D-model step always runs afterward regardless. */
async function advisoryPairTriage(
  ctx: StepUnitContext,
  newTexts: ReadonlyMap<number, string>,
  oldTexts: ReadonlyMap<number, string>,
): Promise<void> {
  const advisory = advisoryForStep(ctx);
  const snapshot = ctx.scratch.proposal;
  if (advisory === null || snapshot === null) return;
  const pairs: PairSubject[] = [];
  for (const [newId, olds] of snapshot.pairs) {
    const newText = newTexts.get(newId);
    if (newText === undefined) continue;
    for (const oldId of olds) {
      const oldText = oldTexts.get(oldId);
      if (oldText === undefined) continue;
      pairs.push({ newId, oldId, newText, oldText });
    }
  }
  if (pairs.length === 0) return;
  try {
    const verdicts = await judgePairs(advisory.deps, advisory.run, pairs, ctx.now());
    const at = ctx.now();
    const model = advisory.deps.provider?.model ?? "none";
    const entries: JudgmentRecordEntry[] = [];
    for (const [subject, v] of verdicts) {
      entries.push({
        runId: ctx.runId, step: ctx.stepName, principal: ctx.primaryUserId,
        gate: "pre-triage", subject, decision: `triage=${v.triage}`,
        verdict: v.verdict, questionSet: SLEEP_SUPPORT_QUESTION_SET,
        model, reason: v.reason, at,
      });
    }
    recordAdvisory(ctx, entries);
  } catch (err) {
    // Advisory only: the full step runs next regardless.
    logWarn(TAG, `[SLEEP] ${ctx.stepName} — advisory pair triage failed (${err instanceof Error ? err.message : String(err)}); full step proceeds`);
  }
}

/** Route one step name to its unit. Steps without a domain branch use the generic prompt unit. */
export async function runStepUnit(stepName: string, ctx: StepUnitContext): Promise<StepUnitOutcome> {
  switch (stepName) {
    case "daily-summary": return runDailySummaryStep(ctx);
    case "extract-memories": return runExtractMemoriesStep(ctx);
    case "contradiction-and-graph": return runContradictionStep(ctx);
    case "rem-synthesis": return runRemStep(ctx);
    case "retrospective": return runRetrospectiveStep(ctx);
    case "skill-review": return runSkillReviewStep(ctx);
    case "gc-noise": return runGcStep(ctx);
    case "retro-derive": return runRetroDeriveStep(ctx);
    case "consolidation": return runConsolidationStep(ctx);
    case "feedback": return dispatchPromptStep(ctx, { prepare: prepareFeedback });
    case "memory-maintenance": return dispatchPromptStep(ctx, { prepare: prepareMaintenance });
    case "translation": return dispatchPromptStep(ctx, { prepare: prepareTranslation });
    default: return dispatchPromptStep(ctx);
  }
}

/** #1860: translate a daily-summary build into ledger claims scoped to the
 *  principal it read. Covered and skipped intervals carry their session
 *  scope; exclusions carry their reason. */
export function claimsForDailySummary(userId: string, result: DailySummaryResult): CoverageClaim[] {
  return [
    ...result.covered.map(c => ({
      principal: userId, scope: c.scope, startTs: c.startTs, endTs: c.endTs,
      disposition: "covered" as const,
    })),
    ...result.skipped.map(s => ({
      principal: userId, scope: s.scope, startTs: s.startTs, endTs: s.endTs,
      disposition: "unclaimed" as const,
    })),
    ...result.excluded.map(e => ({
      principal: userId, scope: "excluded" as const, startTs: e.startTs, endTs: e.endTs,
      disposition: "excluded" as const, reason: e.reason,
    })),
  ];
}

async function runDailySummaryStep(ctx: StepUnitContext): Promise<StepUnitOutcome> {
  const { stepName, stepLogDir, stepIndex, startMs, stepDeadlineAt, runtime, runId, signal, retryDelays, now, budget, sleepData, memoryDir, scratch } = ctx;
  try {
    const ctxWindow = getAbmindEnv().sleepCtxWindow;
    const userId = sleepData.getPrimaryUserId();
    const watermarkTs = sleepData.getExtractionWatermark(userId);

    const result = await buildDailySummary(sleepData.getDb(), (p) => sendToRuntime(runtime, p, "daily-summary", runId, signal, stepDeadlineAt, budget, retryDelays, now).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }), {
      ctxWindow, memoryDir, userId, watermarkTs,
    });
    if (result) {
      // #1821: the filename is the write instant; the covered window
      // reported by the build owns the heading.
      // #1863: assert the run principal before the write (a non-master run
      // never reaches it, including the supersede-delete path) and bind
      // host-authored owner provenance to the artifact.
      sleepData.assertWritePrincipal(userId);
      const path = writeDailyFile(memoryDir, result.startTs, result.endTs, result.summary, Date.now(), userId, { covered: result.covered, skipped: result.skipped });
      // #1752 R7: bind actual write path before retrospective substitution; covers non-current dated summaries
      scratch.dailySummaryPath = path;
      scratch.vars.DAILY_PATH = scratch.vars.RETRO_PATH = path;
      scratch.acceptedOutputChars.set("daily-summary", result.summary.length);
      writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${stepName}.md`), redactSecrets(result.summary), "utf-8");
      logInfo(TAG, `[SLEEP] ✓ ${stepName} (${((Date.now() - startMs) / 1000).toFixed(1)}s)`);
      return { kind: "ok", durationS: durationS(Date.now() - startMs), path, claims: claimsForDailySummary(userId, result) };
    }
    logInfo(TAG, `[SLEEP] ✗ ${stepName} (${((Date.now() - startMs) / 1000).toFixed(1)}s)`);
    return { kind: "skipped" };
  } catch (err) {
    if (isSleepModelFailure(err)) {
      recordModelEvidence(ctx, err);
      logWarn(TAG, `[SLEEP] ${stepName} — terminal model failure (${err.reason}), stopping sleep (not advancing to next phase)`);
      return { kind: "terminal", elapsedMs: Date.now() - startMs, reason: err.reason, failure: failureFromError(err, "unknown") };
    }
    logWarn(TAG, `[SLEEP] daily-summary failed: ${err instanceof Error ? err.message : String(err)}`);
    const failure = failureFromError(err, "unknown");
    logInfo(TAG, `[SLEEP] ✗ ${stepName} (${((Date.now() - startMs) / 1000).toFixed(1)}s)`);
    return { kind: "failed", durationS: durationS(Date.now() - startMs), failure, stopWhenEssential: false };
  }
}

async function runExtractMemoriesStep(ctx: StepUnitContext): Promise<StepUnitOutcome> {
  const { stepName, stepLogDir, stepIndex, startMs, stepDeadlineAt, runtime, runId, signal, retryDelays, now, budget, sleepData, memoryDir, primaryUserId, watermarkTargetTs, scratch } = ctx;
  if (!scratch.dailySummaryPath) {
    logInfo(TAG, `[SLEEP] ⏭ ${stepName} — no daily summary`);
    return { kind: "skipped" };
  }
  const memDb = getMemoryDb(ctx.memory);
  if (!memDb) {
    const failure = toBoundedFailure("service_failed", "memory database unavailable for extraction");
    return { kind: "failed", durationS: 0, failure, stopWhenEssential: true };
  }
  try {
    const dailyContent = (readDailyArtifactRaw(scratch.dailySummaryPath) ?? "").slice(0, 20_000);
    const watermarkTs = sleepData.getExtractionWatermark(primaryUserId);
    const allOffered = collectOfferedMessages(sleepData, primaryUserId, watermarkTs, watermarkTargetTs);
    const offerCap = EXTRACTION_BATCH_MESSAGES * MAX_EXTRACTION_BATCHES;
    const budgetExhausted = allOffered.length > offerCap;
    const offered = budgetExhausted ? allOffered.slice(0, offerCap) : allOffered;
    if (offered.length === 0) {
      logInfo(TAG, `[SLEEP] ⏭ ${stepName} — no messages above the watermark to settle`);
      return { kind: "skipped" };
    }
    const batches: OfferedMessage[][] = [];
    for (let i = 0; i < offered.length; i += EXTRACTION_BATCH_MESSAGES) {
      batches.push(offered.slice(i, i + EXTRACTION_BATCH_MESSAGES));
    }
    const responses: string[] = [];
    const unhandled: number[] = [];
    const advisory = advisoryForStep(ctx);
    for (let b = 0; b < Math.min(batches.length, MAX_EXTRACTION_BATCHES); b++) {
      const batch = batches[b]!;
      const prompt = renderExtractionPrompt(dailyContent, batch, b > 0);
      const response = await sendToRuntime(runtime, prompt, stepName, runId, signal, stepDeadlineAt, budget, retryDelays, now, { proposalOnly: true });
      if (response === null) throw new LLMUnavailableError();
      responses.push(response);
      const applied = await applyExtractionBatch({
        db: memDb,
        sleepData,
        memoryDir,
        runId,
        priorRunId: ctx.priorRunId,
        step: stepName,
        principal: primaryUserId,
        batch,
        response,
        ...(advisory !== null ? { advisoryJudge: advisory.judge } : {}),
      });
      unhandled.push(...applied.unhandled);
    }
    scratch.acceptedOutputChars.set(stepName, responses.join("\n").trim().length);
    writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${stepName}.md`), redactSecrets(responses.join("\n\n---\n\n")), "utf-8");
    if (budgetExhausted || unhandled.length > 0) {
      const detail = budgetExhausted
        ? `extraction budget exhausted — more than ${offerCap} messages above the watermark; unoffered messages remain unhandled`
        : `offered messages without a disposition: ${unhandled.slice(0, 10).join(",")}`;
      const failure = toBoundedFailure("service_failed", detail);
      logWarn(TAG, `[SLEEP] ${stepName} — incomplete: ${detail}`);
      return { kind: "failed", durationS: durationS(Date.now() - startMs), failure, stopWhenEssential: true };
    }
    logInfo(TAG, `[SLEEP] ✓ ${stepName} (${((Date.now() - startMs) / 1000).toFixed(1)}s) — ${responses.join(" ").slice(0, 80)}`);
    return { kind: "ok", durationS: durationS(Date.now() - startMs) };
  } catch (err) {
    if (isSleepModelFailure(err)) {
      recordModelEvidence(ctx, err);
      logWarn(TAG, `[SLEEP] ${stepName} — terminal model failure (${err.reason}), stopping sleep (not advancing to next phase)`);
      return { kind: "terminal", elapsedMs: Date.now() - startMs, reason: err.reason, failure: failureFromError(err, "unknown") };
    }
    logWarn(TAG, `[SLEEP] extract-memories failed: ${err instanceof Error ? err.message : String(err)}`);
    const failure = failureFromError(err, "unknown");
    return { kind: "failed", durationS: durationS(Date.now() - startMs), failure, stopWhenEssential: false };
  }
}

// ── Prompt-step preparation hooks ────────────────────────────────────────────
// Each returns a skip outcome to stop before dispatch, or null to proceed.
// Preparation failures keep step-level meaning and never charge a model call.

/** #1859: owner-scoped revision snapshot over exactly the ids rendered into
 *  a fenced prompt. Ids that are foreign, sealed, or inactive never enter
 *  the snapshot — naming them later rejects as outside the shown set. */
function snapshotFor(
  ctx: StepUnitContext,
  stepName: string,
  eligible: readonly ProposalOp[],
  shownTexts: readonly string[],
  pairs?: Map<number, Set<number>>,
): ProposalSnapshot | null {
  const db = getMemoryDb(ctx.memory);
  if (!db) return null;
  const snapshot = emptySnapshot(ctx.runId, stepName, ctx.primaryUserId, eligible);
  const ids = shownTexts.flatMap((text) => [...parseHashIds(text), ...parseBracketIds(text)]);
  for (const [id, revision] of snapshotRevisions(db, ctx.primaryUserId, ids)) {
    snapshot.shown.set(id, revision);
  }
  if (pairs) {
    for (const [newId, olds] of pairs) snapshot.pairs.set(newId, olds);
  }
  return snapshot;
}

async function prepareContradiction(ctx: StepUnitContext): Promise<StepUnitOutcome | null> {
  const { stepName, now, sleepData, primaryUserId, runStartedAt, scratch } = ctx;
  try {
    const todayStart = new Date(now());
    todayStart.setHours(0, 0, 0, 0);
    const newRows = sleepData.getContradictionEvidence(primaryUserId, todayStart.getTime());
    if (newRows.length === 0) {
      logInfo(TAG, `[SLEEP] ⏭ ${stepName} — no new extractions today`);
      return { kind: "skipped" };
    }
    scratch.vars.NEW_EXTRACTIONS = newRows.map(r => `[id=${r.id}] (${r.memory_type}, trust=${r.trust}) ${r.content_en}`).join("\n");
    for (const r of newRows) scratch.newEvidenceRevisions.set(r.id, r.semantic_revision);
    const candidateIds = new Set<number>();
    const candidateRows: Array<{ id: number; content_en: string; memory_type: string; trust: number; credibility: number; semantic_revision: number }> = [];
    // #1859: per-new evidence links — an invalidation pair must have been
    // shown for THAT new id, not merely present in the union of candidates.
    const pairLinks = new Map<number, Set<number>>();
    for (const nr of newRows.slice(0, 5)) {
      const keywords = nr.content_en.split(/\s+/).filter(w => w.length > 3).slice(0, 3).join(" OR ");
      if (!keywords) continue;
      try {
        const matches = sleepData.getContradictionCandidates(primaryUserId, keywords, nr.id, nr.trust);
        if (matches.length > 0) pairLinks.set(nr.id, new Set());
        for (const m of matches) {
          if (!candidateIds.has(m.id) && candidateIds.size < 20) {
            candidateIds.add(m.id);
            candidateRows.push(m);
          }
          if (candidateIds.has(m.id)) pairLinks.get(nr.id)!.add(m.id);
        }
      } catch { /* FTS query might fail on special chars — skip */ }
    }
    for (const m of candidateRows) scratch.existingEvidenceRevisions.set(m.id, m.semantic_revision);
    scratch.vars.CONTRADICTION_CANDIDATES = candidateRows.length > 0
      ? candidateRows.map(r => `[id=${r.id}] (${r.memory_type}, trust=${r.trust}, cred=${r.credibility}) ${r.content_en}`).join("\n")
      : "No existing memories with overlapping content found.";
    // #1515: current-run attribution — bounded inference over the
    // primary user's non-observation rows in the run window that were
    // actually rendered into NEW_EXTRACTIONS. Bound parameters only;
    // skipped entirely when nothing new was rendered.
    if (scratch.newEvidenceRevisions.size > 0) {
      const step05PreparedAt = now();
      const newIds = [...scratch.newEvidenceRevisions.keys()];
      const currentRows = sleepData.getCurrentRunNewIds(primaryUserId, runStartedAt, step05PreparedAt, newIds);
      for (const cr of currentRows) scratch.currentRunNewIds.add(cr);
      // #1859: accepted store receipts from this run are the boundary's own
      // record of current-run extractions. They are direct evidence and do
      // not depend on the row clock agreeing with the run clock.
      try {
        for (const receipt of readReceipts(ctx.memoryDir, ctx.runId)) {
          if (receipt.op !== "store" || receipt.disposition !== "accepted") continue;
          if (receipt.step !== "extract-memories" && receipt.step !== "catch-up-extract-memories") continue;
          if (typeof receipt.memoryId === "number" && scratch.newEvidenceRevisions.has(receipt.memoryId)) {
            scratch.currentRunNewIds.add(receipt.memoryId);
          }
        }
      } catch { /* receipt read reconciles to nothing */ }
    }
    // #1859: bounded candidate snapshot for the fenced turn.
    const snapshot = snapshotFor(ctx, stepName, ["contradict", "relation"],
      [scratch.vars.NEW_EXTRACTIONS ?? "", scratch.vars.CONTRADICTION_CANDIDATES ?? ""], pairLinks);
    if (!snapshot) return { kind: "skipped" };
    snapshot.currentRunNew = new Set(scratch.currentRunNewIds);
    scratch.proposal = snapshot;
    // #1817: advisory pre-triage over the shown pairs. The full D-model
    // step dispatches next regardless of these verdicts.
    const newTexts = new Map(newRows.map(r => [r.id, r.content_en] as const));
    const oldTexts = new Map(candidateRows.map(r => [r.id, r.content_en] as const));
    await advisoryPairTriage(ctx, newTexts, oldTexts);
    return null;
  } catch (err) {
    logWarn(TAG, `[SLEEP] contradiction-and-graph var prep failed: ${err instanceof Error ? err.message : String(err)}`);
    return { kind: "skipped" };
  }
}

async function prepareRem(ctx: StepUnitContext): Promise<StepUnitOutcome | null> {
  const { stepName, sleepData, primaryUserId, scratch } = ctx;
  try {
    const sample = sleepData.getRemSample(primaryUserId, 10);
    if (sample.length < 5) {
      logInfo(TAG, `[SLEEP] ⏭ ${stepName} — not enough memories for REM`);
      return { kind: "skipped" };
    }
    scratch.vars.REM_SAMPLE = sample.map(r => `[${r.memory_type}, ${new Date(r.created_at).toISOString().slice(0, 10)}] ${r.content_en}`).join("\n");
    // #1859: REM only proposes new observation rows — no shown ids needed,
    // but the snapshot must exist for the fenced turn.
    const snapshot = snapshotFor(ctx, stepName, ["observe"], []);
    if (!snapshot) return { kind: "skipped" };
    scratch.proposal = snapshot;
    return null;
  } catch {
    return { kind: "skipped" };
  }
}

/** #1859: shown-candidate snapshots for the metadata steps. Revisions are
 *  captured from the rendered lists; edits are CAS-checked at apply. */
async function prepareFeedback(ctx: StepUnitContext): Promise<StepUnitOutcome | null> {
  const snapshot = snapshotFor(ctx, ctx.stepName, ["relevance"], [ctx.scratch.vars.RECALL_FEEDBACK ?? ""]);
  if (!snapshot) return { kind: "skipped" };
  ctx.scratch.proposal = snapshot;
  return null;
}

async function prepareMaintenance(ctx: StepUnitContext): Promise<StepUnitOutcome | null> {
  const mergeText = ctx.scratch.vars.MERGE_CANDIDATES ?? "";
  const pairs = new Map<number, Set<number>>();
  const pairRe = /#(\d+)\s*[^\n]*?↔[^\n]*?#(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(mergeText)) !== null) {
    const a = parseInt(m[1]!, 10);
    const b = parseInt(m[2]!, 10);
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a === b) continue;
    if (!pairs.has(a)) pairs.set(a, new Set());
    if (!pairs.has(b)) pairs.set(b, new Set());
    pairs.get(a)!.add(b);
    pairs.get(b)!.add(a);
  }
  const snapshot = snapshotFor(ctx, ctx.stepName, ["topic", "merge_keep", "emotion_context"],
    [ctx.scratch.vars.UNTAGGED_MEMORIES ?? "", mergeText, ctx.scratch.vars.EMOTION_CONTEXT_GAPS ?? ""], pairs);
  if (!snapshot) return { kind: "skipped" };
  ctx.scratch.proposal = snapshot;
  return null;
}

async function prepareTranslation(ctx: StepUnitContext): Promise<StepUnitOutcome | null> {
  const snapshot = snapshotFor(ctx, ctx.stepName, ["translation_fix"], [ctx.scratch.vars.TRANSLATION_ISSUES ?? ""]);
  if (!snapshot) return { kind: "skipped" };
  ctx.scratch.proposal = snapshot;
  return null;
}

async function prepareRetrospective(ctx: StepUnitContext): Promise<StepUnitOutcome | null> {
  // #1752 R7: retrospective requires a readable daily artifact; skip when legitimately absent and avoid misreporting as model failure
  const { dailySummaryStatus, scratch } = ctx;
  const effectivePath: string | null = scratch.dailySummaryPath;
  if (!effectivePath) {
    logInfo(TAG, `[SLEEP] ⏭ retrospective — no daily summary artifact (daily-summary: ${dailySummaryStatus})`);
    return { kind: "skipped" };
  }
  const artifact = readDailyArtifact(effectivePath);
  if (!artifact.usable) {
    logWarn(TAG, `[SLEEP] ⏭ retrospective — daily artifact missing or unusable (${effectivePath}) — leaving daily-summary for review`);
    return { kind: "skipped" };
  }
  scratch.retrospectiveBeforeContent = readDailyArtifactRaw(effectivePath);
  if (scratch.retrospectiveBeforeContent === null) {
    logWarn(TAG, `[SLEEP] ⏭ retrospective — daily artifact became unreadable (${effectivePath})`);
    return { kind: "skipped" };
  }
  scratch.vars.DAILY_PATH = scratch.vars.RETRO_PATH = effectivePath;
  scratch.dailySummaryPath = effectivePath;
  return null;
}

async function prepareGc(ctx: StepUnitContext): Promise<StepUnitOutcome | null> {
  const { sleepData, lastSleepTs, scratch } = ctx;
  try {
    const gcMsgs = sleepData.getMessagesAfter(lastSleepTs, sleepData.getPrimaryUserId())
      .filter(m => !m.content.startsWith("[SYSTEM"));
    scratch.gcValidIds = new Set(gcMsgs.map(m => m.id));
    scratch.vars.GC_MESSAGES = gcMsgs.length > 0
      ? gcMsgs.map(m => `[id:${m.id}] [${m.role}] ${m.content.slice(0, 300)}`).join("\n")
      : "No messages since last sleep — respond with [].";
    // #1817: bounded redacted excerpts for advisory triage. Every message
    // is kept regardless of the verdict recorded from these.
    scratch.gcExcerpts = new Map(gcMsgs.map(m => [m.id, redactSecrets(m.content).slice(0, 300)]));
  } catch {
    scratch.gcValidIds = new Set();
    scratch.vars.GC_MESSAGES = "Message query failed — respond with [].";
    scratch.gcExcerpts = null;
  }
  return null;
}

async function prepareRetroDerive(ctx: StepUnitContext): Promise<StepUnitOutcome | null> {
  const { stepName, memoryDir, scratch } = ctx;
  const files = knowledgeFileInputs(memoryDir);
  const availability = knowledgeAvailabilitySection(files);
  for (const f of files) {
    scratch.vars[f.name.replace(/\.md$/, "").toUpperCase() + "_PATH"] = f.path;
  }
  scratch.vars.KNOWLEDGE_AVAILABILITY = availability.section;
  const retroRaw = scratch.dailySummaryPath ? readDailyArtifactRaw(scratch.dailySummaryPath) : null;
  scratch.vars.RETRO_CONTENT = retroRaw ?? RETRO_ABSENT_MARKER;

  // #1859: knowledge-file snapshot for the fenced turn — bounded contents
  // plus the 12-char version hash each proposal must echo as `base=`.
  const snapshotSections: string[] = [];
  const snapshot = snapshotFor(ctx, stepName,
    ["promote", "retro_invalidate", "knowledge_add", "knowledge_remove", "knowledge_update"],
    [scratch.vars.PROMOTION_CANDIDATES ?? "", scratch.vars.CONTRADICTION_WARNINGS ?? ""],
    retroPairs(scratch.vars.CONTRADICTION_WARNINGS ?? ""));
  if (!snapshot) return { kind: "skipped" };
  for (const name of KNOWLEDGE_FILES) {
    const version = readKnowledgeVersion(memoryDir, name);
    if ("unavailable" in version) {
      snapshot.knowledgeUnavailable.set(name, version.unavailable);
      snapshotSections.push(`### ${name}\n${version.unavailable === "absent" ? "ABSENT — skip its update, report the skip." : "UNREADABLE — report failure for this file."}`);
      continue;
    }
    snapshot.knowledge.set(name, version);
    const file = files.find((f) => f.name === name);
    const content = file?.content ?? null;
    snapshotSections.push(`### ${name} (base=${version.hash.slice(0, 12)})\n${content === null ? "UNREADABLE" : content.slice(0, 8 * 1024)}`);
  }
  scratch.vars.KNOWLEDGE_SNAPSHOT = snapshotSections.join("\n\n");
  scratch.proposal = snapshot;
  return null;
}

/** #1859: `#new contradicts #old` warnings are the retro-derive evidence
 *  pairs, linked new → old exactly like step-05's candidate links. */
function retroPairs(warnings: string): Map<number, Set<number>> {
  const pairs = new Map<number, Set<number>>();
  const re = /#(\d+)\s+contradicts\s+#(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(warnings)) !== null) {
    const newId = parseInt(m[1]!, 10);
    const oldId = parseInt(m[2]!, 10);
    if (!Number.isSafeInteger(newId) || !Number.isSafeInteger(oldId) || newId === oldId) continue;
    if (!pairs.has(newId)) pairs.set(newId, new Set());
    pairs.get(newId)!.add(oldId);
  }
  return pairs;
}

/**
 * #1864: the consolidation due decision is per-run code-owned work. The
 * checkpoint is the latest trustworthy published artifact's declared period;
 * a due weekly wins over a due quarterly, and a due weekly with no sources is
 * a no-work skip that still lets a due quarterly run in the same cycle.
 */
async function prepareConsolidation(ctx: StepUnitContext): Promise<StepUnitOutcome | null> {
  const { memoryDir, now, scratch, sleepData } = ctx;
  // #1863: filter consolidation inputs by verified owner provenance when the
  // owner holds a snapshot; without one the legacy unfiltered behavior
  // applies (isolated tests).
  const owner = sleepData.getOwnerSnapshot() ?? undefined;
  let plan: ConsolidationPlan;
  try {
    plan = planConsolidation(memoryDir, localDate(new Date(now())), owner);
  } catch (err) {
    const failure = toBoundedFailure("service_failed", `consolidation cadence check failed: ${err instanceof Error ? err.message : String(err)}`);
    logWarn(TAG, `[SLEEP] consolidation — ${failure.detail}`);
    return { kind: "failed", durationS: 0, failure, stopWhenEssential: true };
  }
  for (const report of plan.reports) {
    if (report.level === "warn") logWarn(TAG, `[SLEEP] consolidation — ${report.message}`);
    else logInfo(TAG, `[SLEEP] consolidation — ${report.message}`);
  }
  if (plan.target === null) {
    logInfo(TAG, `[SLEEP] ⏭ consolidation — ${plan.skipReason}`);
    return { kind: "skipped" };
  }
  const target = plan.target;
  scratch.consolidation = target;
  scratch.vars.DAILY_INPUT_LIST = target.listSection;
  scratch.vars.COVERED_RANGE = target.coveredRange;
  scratch.vars.MISSING_DATES = target.missingDates.length > 0
    ? target.missingDates.join(", ")
    : "none — full coverage.";
  try {
    const { getLatestConsolidationFile } = await import("../consolidation-search.js");
    // #1863: previous consolidation must also carry verified owner provenance.
    const latest = getLatestConsolidationFile(memoryDir, target.tier, owner);
    scratch.vars.PREVIOUS_CONSOLIDATION_SECTION = previousConsolidationSection(latest?.filePath ?? null);
  } catch {
    scratch.vars.PREVIOUS_CONSOLIDATION_SECTION = previousConsolidationSection(null);
  }
  return null;
}

// ── Prompt-step response hooks ───────────────────────────────────────────────

/** #1752 R9 shared probe: the step's work already landed as a tool artifact. */
function retrospectiveArtifactSatisfied(ctx: StepUnitContext): { satisfied: boolean; outputChars: number; artifactPath: string | null } {
  const effectivePath = ctx.scratch.dailySummaryPath;
  if (effectivePath && ctx.scratch.retrospectiveBeforeContent !== null &&
      hasAppendedDailyArtifact(effectivePath, ctx.scratch.retrospectiveBeforeContent)) {
    const appended = readDailyArtifactRaw(effectivePath);
    return {
      satisfied: true,
      outputChars: Math.max(1, (appended?.length ?? 0) - ctx.scratch.retrospectiveBeforeContent.length),
      artifactPath: effectivePath,
    };
  }
  return { satisfied: false, outputChars: 0, artifactPath: effectivePath };
}

async function finishRetrospective(ctx: StepUnitContext, response: string): Promise<{ failure: SleepFailure; stopWhenEssential: boolean } | null> {
  // #1807: retro-derive consumes the persisted artifact, not the
  // closing message. A "done"-only reply still yields full content.
  ctx.scratch.vars.RETRO_CONTENT = (ctx.scratch.dailySummaryPath ? readDailyArtifactRaw(ctx.scratch.dailySummaryPath) : null) ?? response;
  return null;
}

async function finishGcNoise(ctx: StepUnitContext, response: string): Promise<{ failure: SleepFailure; stopWhenEssential: boolean } | null> {
  // #1807: GC selection is code-owned. Parse the JSON array, validate
  // every ID against the supplied set, persist atomically. Model prose
  // is not success evidence; persistence must succeed first.
  const gcOutcome = await persistGcSelection(ctx.memoryDir, response, ctx.scratch.gcValidIds ?? new Set(), ctx.now(), ctx.noteGcIncompatible);
  if (!gcOutcome.ok) {
    const failure = toBoundedFailure("service_failed", gcOutcome.detail);
    logWarn(TAG, `[SLEEP] ${ctx.stepName} — selection persistence failed: ${gcOutcome.detail}`);
    return { failure, stopWhenEssential: true };
  }
  ctx.scratch.gcCycleSelection = gcOutcome.ids;
  // #1817: advisory triage records verdicts; the persisted selection stands.
  await advisoryGcTriage(ctx);
  return null;
}

async function finishContradiction(ctx: StepUnitContext, response: string): Promise<{ failure: SleepFailure; stopWhenEssential: boolean } | null> {
  const { sleepData, memory, primaryUserId, memoryDir, runId, now } = ctx;
  const memDb = getMemoryDb(memory);
  if (memDb) {
    // #1859: model-directed CONTRADICT/RELATION are applied by the proposal
    // boundary in dispatchPromptStep. This hook keeps only the deterministic
    // decay sweep and issues the same durable receipts for its writes.
    const EVENT_MIN_AGE_DAYS = 7;
    const DECAY_THRESHOLD = 0.1;
    const nowMs = now();
    const decayCandidates = sleepData.getDecayCandidates(primaryUserId, nowMs - EVENT_MIN_AGE_DAYS * 86400_000);
    const decayReceipts: WriteReceipt[] = [];
    for (const m of decayCandidates) {
      const ageDays = (nowMs - m.created_at) / 86400_000;
      const score = m.recall_count / ageDays;
      if (score < DECAY_THRESHOLD) {
        const aged = sleepData.getDecayTarget(primaryUserId, m.id);
        if (aged) {
          const result = sleepData.invalidateMemory(primaryUserId, m.id, aged.semantic_revision, localDate(new Date(nowMs)), "sleep:decay");
          if (result.ok) {
            decayReceipts.push({
              runId, step: ctx.stepName, principal: primaryUserId,
              opId: `${runId}/${ctx.stepName}/decay-${m.id}`,
              op: "decay", disposition: "accepted", memoryId: m.id,
              reason: `faded event score ${score.toFixed(3)} < ${DECAY_THRESHOLD}`,
              at: nowMs,
            });
          }
        }
      }
    }
    if (decayReceipts.length > 0) {
      try {
        writeReceipts(memoryDir, decayReceipts);
      } catch (err) {
        const failure = toBoundedFailure("service_failed", `receipt persistence failed for decay: ${err instanceof Error ? err.message : String(err)}`);
        logWarn(TAG, `[SLEEP] ${ctx.stepName} — ${failure.detail}`);
        return { failure, stopWhenEssential: true };
      }
      ctx.scratch.proposalReceipts = [...ctx.scratch.proposalReceipts, ...decayReceipts];
      logInfo(TAG, `[SLEEP] Aged out ${decayReceipts.length} faded event memories (score < ${DECAY_THRESHOLD})`);
    }
  }
  return null;
}

// ── Shared prompt dispatch ───────────────────────────────────────────────────

interface PromptStepHooks {
  /** Step-specific input preparation; a skip outcome stops before dispatch. */
  prepare?: (ctx: StepUnitContext) => Promise<StepUnitOutcome | null>;
  /** R9 probe for steps whose work may already persist as an artifact. */
  artifactSatisfied?: (ctx: StepUnitContext) => { satisfied: boolean; outputChars: number; artifactPath: string | null };
  /** Step-specific post-processing of a truthy response; may convert ok to failed. */
  finishResponse?: (ctx: StepUnitContext, response: string) => Promise<{ failure: SleepFailure; stopWhenEssential: boolean } | null>;
}

/** Standard prompt-driven step — JIT substitution, dispatch, classification.
 *  #1859: fenced steps dispatch proposal-only; their response is applied
 *  through the candidate boundary and receipts are persisted before the
 *  step may report ok. */
async function dispatchPromptStep(ctx: StepUnitContext, hooks: PromptStepHooks = {}): Promise<StepUnitOutcome> {
  const { stepName, essential, stepLogDir, stepIndex, startMs, stepDeadlineAt, runtime, runId, signal, retryDelays, now, budget, memory, memoryDir, sleepData, primaryUserId, scratch } = ctx;

  if (hooks.prepare) {
    const prep = await hooks.prepare(ctx);
    if (prep) return prep;
  }

  const fenced = isProposalOnlyStep(stepName);
  if (fenced && scratch.proposal === null) {
    // A fenced turn without a prepared candidate snapshot must never reach
    // the model: the boundary has nothing to validate against.
    const failure = toBoundedFailure("service_failed", `proposal-only step ${stepName} has no candidate snapshot`);
    logWarn(TAG, `[SLEEP] ${stepName} — ${failure.detail}`);
    return { kind: "failed", durationS: 0, failure, stopWhenEssential: true };
  }

  // #1752 R7: steps appending to DAILY_PATH guard before prompt substitution.
  // Retrospective's own preparation above already covers its absent-artifact
  // case; this guard is what stops skill-review when no artifact exists.
  if (DAILY_ARTIFACT_STEPS.has(stepName) && !scratch.dailySummaryPath) {
    logInfo(TAG, `[SLEEP] ⏭ ${stepName} — no daily summary artifact`);
    return { kind: "skipped" };
  }

  // #1807: shared preparation boundary — validate template bindings
  // before dispatch. A preparation failure is a step-level service
  // diagnostic following essential/non-essential rules; it never
  // triggers provider quarantine or consumes a provider call.
  const prepared = prepareStepDispatch(stepName, ctx.rawPrompt, scratch.vars);
  if (prepared.status !== "ready") {
    if (prepared.status === "no_work") {
      logInfo(TAG, `[SLEEP] ⏭ ${stepName} — ${prepared.reason}`);
      return { kind: "skipped" };
    }
    const failure = toBoundedFailure("service_failed", prepared.detail);
    logWarn(TAG, `[SLEEP] ${stepName} — preparation failed: ${prepared.detail}`);
    return { kind: "failed", durationS: 0, failure, stopWhenEssential: true };
  }
  const prompt = prepared.prompt;
  const fullPrompt = scratch.soulPrefix + prompt;
  if (scratch.soulPrefix) scratch.soulPrefix = "";
  let response: string | null;
  try {
    response = await sendToRuntime(runtime, fullPrompt, stepName, runId, signal, stepDeadlineAt, budget, retryDelays, now, fenced ? { proposalOnly: true } : undefined);
  } catch (err) {
    if (isSleepModelFailure(err)) {
      recordModelEvidence(ctx, err);
      const reason = (err as SleepModelFailureError).reason;
      // #1752 R9: retrospective empty but artifact present — work was done via tools; don't fail step for missing closing prose
      if (reason === "invalid_response" && hooks.artifactSatisfied) {
        const sat = hooks.artifactSatisfied(ctx);
        if (sat.satisfied) {
          logInfo(TAG, `[SLEEP] ${stepName} empty response but artifact was appended (${sat.artifactPath}) — marking ok per R9`);
          scratch.acceptedOutputChars.set(stepName, sat.outputChars);
          return { kind: "ok", durationS: durationS(Date.now() - startMs) };
        }
      }
      // #1752 R11: invalid_response on non-essential step must not terminate cycle
      const isEssential = sleepStepConfig(stepName)?.essential ?? essential;
      if (reason === "invalid_response" && !isEssential) {
        const failure = failureFromError(err, "unknown");
        logWarn(TAG, `[SLEEP] ${stepName} — invalid_response on non-essential step, continuing (not terminal)`);
        return { kind: "failed", durationS: durationS(Date.now() - startMs), failure, stopWhenEssential: false };
      }
      logWarn(TAG, `[SLEEP] ${stepName} — terminal model failure (${reason}), stopping sleep (not advancing to next phase)`);
      return { kind: "terminal", elapsedMs: Date.now() - startMs, reason, failure: failureFromError(err, "unknown") };
    }
    throw err;
  }
  const elapsedMs = Date.now() - startMs;

  // Checkpoint boundary: after the awaited call, before applying its output.
  if (signal.aborted) return { kind: "aborted" };

  if (response) {
    scratch.acceptedOutputChars.set(stepName, response.length);
    writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${stepName}.md`), redactSecrets(response), "utf-8");
    scratch.vars[stepName.toUpperCase().replace(/-/g, "_") + "_OUTPUT"] = response;

    // #1859: apply the fenced step's proposals and persist receipts BEFORE
    // any finish hook or ok report. A receipt failure fails the step: an
    // unrecorded consequential write is an unhandled input.
    if (fenced && scratch.proposal) {
      const memDb = getMemoryDb(memory);
      if (!memDb) {
        const failure = toBoundedFailure("service_failed", `memory database unavailable for ${stepName}`);
        return { kind: "failed", durationS: durationS(elapsedMs), failure, stopWhenEssential: true };
      }
      try {
        // #1817: the advisory hook annotates receipts; dispositions are
        // identical with judgments off.
        const advisory = advisoryForStep(ctx);
        const applied = await applyProposals(
          {
            db: memDb,
            sleepData,
            memoryDir,
            snapshot: scratch.proposal,
            alreadyAccepted: loadAcceptedReceipts(memoryDir, [runId, ctx.priorRunId], stepName),
            now,
            ...(advisory !== null ? { advisoryJudge: advisory.judge } : {}),
          },
          response,
        );
        persistProposalReceipts(memoryDir, applied.receipts);
        const accepted = applied.receipts.filter(r => r.disposition === "accepted").length;
        const rejected = applied.receipts.filter(r => r.disposition === "rejected").length;
        if (accepted > 0 || rejected > 0 || applied.overflowDropped > 0) {
          const firstReject = applied.receipts.find(r => r.disposition === "rejected");
          logInfo(TAG, `[SLEEP] ${stepName} proposals: ${accepted} accepted, ${rejected} rejected${applied.overflowDropped > 0 ? `, ${applied.overflowDropped} over budget` : ""}${firstReject?.reason ? ` (first rejection: ${firstReject.reason})` : ""}`);
        }
        scratch.proposalReceipts = applied.receipts;
      } catch (err) {
        const failure = toBoundedFailure("service_failed", `receipt persistence failed for ${stepName}: ${err instanceof Error ? err.message : String(err)}`);
        logWarn(TAG, `[SLEEP] ${stepName} — ${failure.detail}`);
        return { kind: "failed", durationS: durationS(elapsedMs), failure, stopWhenEssential: true };
      }
    }

    if (hooks.finishResponse) {
      const converted = await hooks.finishResponse(ctx, response);
      if (converted) {
        return { kind: "failed", durationS: durationS(elapsedMs), failure: converted.failure, stopWhenEssential: converted.stopWhenEssential };
      }
    }
    return { kind: "ok", durationS: durationS(elapsedMs), promptTail: { responseChars: response.length } };
  }
  // #1752 R9: retrospective empty string with satisfied artifact is not a failure — budget null/abort keeps its meaning
  if (response === "" && !signal.aborted && hooks.artifactSatisfied) {
    const sat = hooks.artifactSatisfied(ctx);
    if (sat.satisfied) {
      logInfo(TAG, `[SLEEP] ${stepName} empty response but artifact was appended (${sat.artifactPath}) — marking ok per R9`);
      scratch.acceptedOutputChars.set(stepName, sat.outputChars);
      logInfo(TAG, `[SLEEP] ✓ ${stepName} (${(elapsedMs / 1000).toFixed(1)}s, artifact satisfied despite empty response)`);
      return { kind: "ok", durationS: durationS(elapsedMs), resetFailures: true };
    }
  }
  // null: budget exhausted or caller aborted mid-call (invalid-response
  // exhaustion now raises the typed terminal error instead). Empty string
  // without artifact satisfaction reports empty/no-response, not tool diagnostic.
  const failure = toBoundedFailure(signal.aborted ? "aborted" : "unknown", signal.aborted ? "cancelled" : "no response");
  return { kind: "failed", durationS: durationS(elapsedMs), failure, stopWhenEssential: false, promptTail: { responseChars: 0 } };
}

// ── Per-step units ───────────────────────────────────────────────────────────

async function runContradictionStep(ctx: StepUnitContext): Promise<StepUnitOutcome> {
  return dispatchPromptStep(ctx, { prepare: prepareContradiction, finishResponse: finishContradiction });
}

async function runRemStep(ctx: StepUnitContext): Promise<StepUnitOutcome> {
  return dispatchPromptStep(ctx, { prepare: prepareRem });
}

async function prepareSkillReview(ctx: StepUnitContext): Promise<StepUnitOutcome | null> {
  // #1843 decision 1+2: skill-review needs a readable daily artifact (skip
  // when legitimately absent, never a model failure) plus the bounded dated
  // review window — the same seven-day selection consolidation sees.
  const { memoryDir, now, scratch } = ctx;
  const effectivePath: string | null = scratch.dailySummaryPath;
  if (!effectivePath) {
    logInfo(TAG, `[SLEEP] ⏭ skill-review — no daily summary artifact`);
    return { kind: "skipped" };
  }
  const artifact = readDailyArtifact(effectivePath);
  if (!artifact.usable) {
    logWarn(TAG, `[SLEEP] ⏭ skill-review — daily artifact missing or unusable (${effectivePath})`);
    return { kind: "skipped" };
  }
  const before = readDailyArtifactRaw(effectivePath);
  if (before === null) {
    logWarn(TAG, `[SLEEP] ⏭ skill-review — daily artifact became unreadable (${effectivePath})`);
    return { kind: "skipped" };
  }
  scratch.skillReviewBeforeContent = before;
  scratch.vars.DAILY_PATH = scratch.vars.RETRO_PATH = effectivePath;
  // #1863: same owner-filtered window consolidation sees.
  const selection = consolidationInputs(memoryDir, new Date(now()), false, ctx.sleepData.getOwnerSnapshot() ?? undefined);
  scratch.vars.SKILL_REVIEW_DAILIES = selection.selected.length > 0
    ? selection.listSection
    : "ABSENT — no daily artifacts in the covered range; make no new-skill recommendation.";
  scratch.vars.SKILL_REVIEW_MISSING_DATES = selection.missingDates.length > 0
    ? selection.missingDates.join(", ")
    : "none — full coverage.";
  return null;
}

/** #1843 decision 3: prove the step appended a recommendation section to the
 *  exact artifact bound before the model call. The prefix match rejects
 *  rewrites; the heading check rejects unrelated appends. */
function skillReviewArtifactSatisfied(ctx: StepUnitContext): { satisfied: boolean; outputChars: number; artifactPath: string | null } {
  const effectivePath = ctx.scratch.dailySummaryPath;
  const before = ctx.scratch.skillReviewBeforeContent;
  if (!effectivePath || before === null) return { satisfied: false, outputChars: 0, artifactPath: effectivePath };
  if (!hasAppendedDailyArtifact(effectivePath, before)) return { satisfied: false, outputChars: 0, artifactPath: effectivePath };
  const current = readDailyArtifactRaw(effectivePath);
  if (current === null || !current.slice(before.length).includes("## Recommended skills")) {
    return { satisfied: false, outputChars: 0, artifactPath: effectivePath };
  }
  return { satisfied: true, outputChars: Math.max(1, current.length - before.length), artifactPath: effectivePath };
}

async function finishSkillReview(ctx: StepUnitContext, response: string): Promise<{ failure: SleepFailure; stopWhenEssential: boolean } | null> {
  // #1843 decision 3: two valid outcomes. An appended recommendation section
  // is ok; an explicit no-recommendations reply needs no append and is ok; a
  // claim with nothing appended fails the (non-essential) step.
  const sat = skillReviewArtifactSatisfied(ctx);
  if (sat.satisfied) {
    ctx.scratch.acceptedOutputChars.set("skill-review", sat.outputChars);
    return null;
  }
  if (/^\s*no recommendations\.?\s*$/i.test(response)) {
    return null;
  }
  const failure = toBoundedFailure("invalid_response", "skill-review response claimed recommendations but appended no ## Recommended skills section to the daily artifact");
  logWarn(TAG, `[SLEEP] skill-review — claimed recommendations without an append; failing step (non-essential, cycle continues)`);
  return { failure, stopWhenEssential: false };
}

async function runSkillReviewStep(ctx: StepUnitContext): Promise<StepUnitOutcome> {
  return dispatchPromptStep(ctx, {
    prepare: prepareSkillReview,
    artifactSatisfied: skillReviewArtifactSatisfied,
    finishResponse: finishSkillReview,
  });
}

async function runRetrospectiveStep(ctx: StepUnitContext): Promise<StepUnitOutcome> {
  return dispatchPromptStep(ctx, {
    prepare: prepareRetrospective,
    artifactSatisfied: retrospectiveArtifactSatisfied,
    finishResponse: finishRetrospective,
  });
}

async function runGcStep(ctx: StepUnitContext): Promise<StepUnitOutcome> {
  return dispatchPromptStep(ctx, { prepare: prepareGc, finishResponse: finishGcNoise });
}

async function runRetroDeriveStep(ctx: StepUnitContext): Promise<StepUnitOutcome> {
  return dispatchPromptStep(ctx, { prepare: prepareRetroDerive });
}

async function runConsolidationStep(ctx: StepUnitContext): Promise<StepUnitOutcome> {
  return dispatchPromptStep(ctx, { prepare: prepareConsolidation, finishResponse: finishConsolidation });
}

/**
 * #1863/#1864: host-published consolidation. The model returns text; abmind
 * binds content, owner, declared period, and the prepared source snapshot,
 * then publishes the weekly/quarterly file after ownership and completion
 * checks. The model-written path is not part of the supported flow, and a
 * failed turn, validation, or write leaves the period due. A failed
 * publication returns a step failure — it never claims success.
 */
async function finishConsolidation(ctx: StepUnitContext, response: string): Promise<{ failure: SleepFailure; stopWhenEssential: boolean } | null> {
  const { memoryDir, scratch, sleepData } = ctx;
  const target = scratch.consolidation;
  if (target === null) {
    logWarn(TAG, `[SLEEP] consolidation — no prepared due target, cannot publish`);
    return { failure: toBoundedFailure("unknown", "consolidation target missing"), stopWhenEssential: true };
  }
  const userId = sleepData.getPrimaryUserId();
  try {
    sleepData.assertWritePrincipal(userId);
  } catch (err) {
    const msg = `consolidation refused: run principal is not the primary owner (${err instanceof Error ? err.message : String(err)})`;
    logWarn(TAG, `[SLEEP] ${msg}`);
    return { failure: toBoundedFailure("unknown", msg), stopWhenEssential: true };
  }
  try {
    const { publishConsolidationFile } = await import("./sleep-daily-summary.js");
    const path = publishConsolidationFile(memoryDir, response, {
      owner: userId,
      tier: target.tier,
      period: target.period,
      coveredRange: target.coveredRange,
      sourcePaths: target.sourcePaths,
    });
    logInfo(TAG, `[SLEEP] ✓ consolidation published (${path})`);
    return null;
  } catch (err) {
    const msg = `consolidation publication failed: ${err instanceof Error ? err.message : String(err)}`;
    logWarn(TAG, `[SLEEP] ${msg}`);
    return { failure: toBoundedFailure("unknown", msg), stopWhenEssential: true };
  }
}
