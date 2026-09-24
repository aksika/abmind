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
import { extractFromDaily } from "../sleep-pipeline.js";
import {
  prepareStepDispatch,
  knowledgeFileInputs,
  knowledgeAvailabilitySection,
  consolidationInputs,
  previousConsolidationSection,
  RETRO_ABSENT_MARKER,
} from "./step-prepare.js";
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
  | { kind: "ok"; durationS: number; path?: string; promptTail?: { responseChars: number }; resetFailures?: true }
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
    default: return dispatchPromptStep(ctx);
  }
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
      const path = writeDailyFile(memoryDir, result.startTs, result.endTs, result.summary);
      // #1752 R7: bind actual write path before retrospective substitution; covers non-current dated summaries
      scratch.dailySummaryPath = path;
      scratch.vars.DAILY_PATH = scratch.vars.RETRO_PATH = path;
      scratch.acceptedOutputChars.set("daily-summary", result.summary.length);
      writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${stepName}.md`), redactSecrets(result.summary), "utf-8");
      logInfo(TAG, `[SLEEP] ✓ ${stepName} (${((Date.now() - startMs) / 1000).toFixed(1)}s)`);
      return { kind: "ok", durationS: durationS(Date.now() - startMs), path };
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
  const { stepName, stepLogDir, stepIndex, startMs, stepDeadlineAt, runtime, runId, signal, retryDelays, now, budget, sleepData, scratch } = ctx;
  if (!scratch.dailySummaryPath) {
    logInfo(TAG, `[SLEEP] ⏭ ${stepName} — no daily summary`);
    return { kind: "skipped" };
  }
  try {
    const userId = sleepData.getPrimaryUserId();
    const result = await extractFromDaily(scratch.dailySummaryPath, userId, (p) => sendToRuntime(runtime, p, "extract-memories", runId, signal, stepDeadlineAt, budget, retryDelays, now).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }));
    scratch.acceptedOutputChars.set("extract-memories", result.trim().length);
    writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${stepName}.md`), redactSecrets(result), "utf-8");
    logInfo(TAG, `[SLEEP] ✓ ${stepName} (${((Date.now() - startMs) / 1000).toFixed(1)}s) — ${result.slice(0, 80)}`);
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
    for (const nr of newRows.slice(0, 5)) {
      const keywords = nr.content_en.split(/\s+/).filter(w => w.length > 3).slice(0, 3).join(" OR ");
      if (!keywords) continue;
      try {
        const matches = sleepData.getContradictionCandidates(primaryUserId, keywords, nr.id, nr.trust);
        for (const m of matches) {
          if (!candidateIds.has(m.id) && candidateIds.size < 20) {
            candidateIds.add(m.id);
            candidateRows.push(m);
          }
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
    }
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
    return null;
  } catch {
    return { kind: "skipped" };
  }
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
  } catch {
    scratch.gcValidIds = new Set();
    scratch.vars.GC_MESSAGES = "Message query failed — respond with [].";
  }
  return null;
}

async function prepareRetroDerive(ctx: StepUnitContext): Promise<StepUnitOutcome | null> {
  const { memoryDir, scratch } = ctx;
  const files = knowledgeFileInputs(memoryDir);
  const availability = knowledgeAvailabilitySection(files);
  for (const f of files) {
    scratch.vars[f.name.replace(/\.md$/, "").toUpperCase() + "_PATH"] = f.path;
  }
  scratch.vars.KNOWLEDGE_AVAILABILITY = availability.section;
  const retroRaw = scratch.dailySummaryPath ? readDailyArtifactRaw(scratch.dailySummaryPath) : null;
  scratch.vars.RETRO_CONTENT = retroRaw ?? RETRO_ABSENT_MARKER;
  return null;
}

async function prepareConsolidation(ctx: StepUnitContext): Promise<StepUnitOutcome | null> {
  const { memoryDir, now, scratch } = ctx;
  // Bound by the loop before the first step; the fallback never fires.
  const outputPath = scratch.vars.CONSOLIDATION_OUTPUT_PATH ?? "";
  const quarterly = outputPath.startsWith(join(memoryDir, "quarterly"));
  const selection = consolidationInputs(memoryDir, new Date(now()), quarterly);
  scratch.vars.DAILY_INPUT_LIST = selection.listSection;
  scratch.vars.COVERED_RANGE = selection.coveredRange;
  scratch.vars.MISSING_DATES = selection.missingDates.length > 0
    ? selection.missingDates.join(", ")
    : "none — full coverage.";
  try {
    const { getLatestConsolidationFile } = await import("../consolidation-search.js");
    const tier = quarterly ? "quarterly" : "weekly";
    const latest = getLatestConsolidationFile(memoryDir, tier);
    scratch.vars.PREVIOUS_CONSOLIDATION_SECTION = previousConsolidationSection(latest?.filePath ?? null);
  } catch {
    scratch.vars.PREVIOUS_CONSOLIDATION_SECTION = previousConsolidationSection(null);
  }
  if (selection.selected.length === 0) {
    logInfo(TAG, `[SLEEP] ⏭ consolidation — no daily artifacts in range`);
    return { kind: "skipped" };
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
  return null;
}

async function finishContradiction(ctx: StepUnitContext, response: string): Promise<{ failure: SleepFailure; stopWhenEssential: boolean } | null> {
  const { sleepData, memory, primaryUserId } = ctx;
  const memDb = getMemoryDb(memory);
  if (memDb) {
    const contradictRe = /CONTRADICT\s+old_id=(\d+)/g;
    let cm: RegExpExecArray | null;
    while ((cm = contradictRe.exec(response)) !== null) {
      const oldId = parseInt(cm[1]!, 10);
      const target = sleepData.getContradictionTarget(primaryUserId, oldId);
      if (target) {
        const result = sleepData.invalidateMemory(primaryUserId, oldId, target.semantic_revision, localDate(new Date()), "sleep:contradiction");
        if (result.ok) logInfo(TAG, `[SLEEP] Invalidated memory #${oldId} (contradicted)`);
      }
    }
    const relationRe = /RELATION\s+entity_a="([^"]+)"\s+entity_b="([^"]+)"\s+rel="([^"]+)"/g;
    let rm: RegExpExecArray | null;
    while ((rm = relationRe.exec(response)) !== null) {
      const [, a, b, rel] = rm;
      const { upsertEdge } = await import("../entity-graph.js");
      upsertEdge(memDb, { userId: primaryUserId, entity_a: a!, entity_b: b!, relation: rel! });
    }
    const EVENT_MIN_AGE_DAYS = 7;
    const DECAY_THRESHOLD = 0.1;
    const nowMs = Date.now();
    const decayCandidates = sleepData.getDecayCandidates(primaryUserId, nowMs - EVENT_MIN_AGE_DAYS * 86400_000);
    let agedCount = 0;
    for (const m of decayCandidates) {
      const ageDays = (nowMs - m.created_at) / 86400_000;
      const score = m.recall_count / ageDays;
      if (score < DECAY_THRESHOLD) {
        const aged = sleepData.getDecayTarget(primaryUserId, m.id);
        if (aged) {
          const result = sleepData.invalidateMemory(primaryUserId, m.id, aged.semantic_revision, localDate(new Date(nowMs)), "sleep:decay");
          if (result.ok) agedCount++;
        }
      }
    }
    if (agedCount > 0) logInfo(TAG, `[SLEEP] Aged out ${agedCount} faded event memories (score < ${DECAY_THRESHOLD})`);
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

/** Standard prompt-driven step — JIT substitution, dispatch, classification. */
async function dispatchPromptStep(ctx: StepUnitContext, hooks: PromptStepHooks = {}): Promise<StepUnitOutcome> {
  const { stepName, essential, stepLogDir, stepIndex, startMs, stepDeadlineAt, runtime, runId, signal, retryDelays, now, budget, scratch } = ctx;

  if (hooks.prepare) {
    const prep = await hooks.prepare(ctx);
    if (prep) return prep;
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
    response = await sendToRuntime(runtime, fullPrompt, stepName, runId, signal, stepDeadlineAt, budget, retryDelays, now);
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
  const selection = consolidationInputs(memoryDir, new Date(now()), false);
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
  const failure = toBoundedFailure("unknown", "skill-review response claimed recommendations but appended no ## Recommended skills section to the daily artifact");
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
  return dispatchPromptStep(ctx, { prepare: prepareConsolidation });
}
