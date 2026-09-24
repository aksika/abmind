#!/usr/bin/env node
/**
 * abmind sleep orchestrator — host-neutral memory-maintenance engine (#1353).
 *
 * Called via runSleepCycle(options). Gathers system state, runs through a
 * pipeline of prompt-driven steps (gc-noise, daily-summary, extract-memories,
 * retrospective, retro-derive, etc.), persists audit log, returns a structured
 * SleepRunResult.
 *
 * abmind owns: step ordering, shared variables/outputs, wired memory
 * maintenance, essential-step/continuation rules, LLM-call budget, durable
 * checkpoints/resume/catch-up/watermark, and the final domain result.
 *
 * The embedding host owns: scheduling, admission, model/provider transport,
 * agent/session lifecycle, cancellation on shutdown, and delivery. The host
 * never reads sleep_*.lock — SleepRunResult is the only supported way to
 * learn what happened.
 *
 * Library-only — no CLI entry point here. Standalone entry lives in
 * cli/abmind-sleep.ts.
 */

import { randomUUID } from "node:crypto";
import { getAbmindEnv } from "../env-schema.js";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { MemoryManager, getMemoryDb } from "../memory-manager.js";
import { loadMemoryConfig } from "../memory-config.js";
import { SleepStateGatherer } from "../sleep-state-gatherer.js";
import { SleepDataAccess } from "../sleep-data-access.js";
import { loadSleepSteps, buildSleepVars } from "../sleep-pipeline.js";
import {
  prepareStepDispatch,
  knowledgeFileInputs,
  knowledgeAvailabilitySection,
  consolidationInputs,
  previousConsolidationSection,
  RETRO_ABSENT_MARKER,
} from "./step-prepare.js";
import { readGcMarks, persistGcSelection } from "./gc-codec.js";
import { buildDailySummary, writeDailyFile, LLMUnavailableError } from "../sleep-pipeline.js";
import { extractFromDaily } from "../sleep-pipeline.js";
import { hasAppendedDailyArtifact, readDailyArtifact, readDailyArtifactRaw } from "./sleep-extract-daily.js";
import { logInfo, logWarn, logError, logTrace } from "../mem-logger.js";
import { localDate } from "../local-time.js";
import type { SleepStep } from "../sleep-pipeline.js";
import { type Level, parseLevel, DEFAULT_LEVEL } from "./levels.js";
import { readStateFile, writeStateFile, runWiredPreTasks, formatWiredResults, isResumableSleepState } from "./state.js";
import type { SleepState } from "./state.js";
import { toDateStr, dateStrToMs, scanPreviousLocks } from "./locks.js";
import { redactSecrets } from "../redact-secrets.js";
import { TransportUnavailableError, LlmBudget, sendToRuntime, MAX_DOMAIN_RETRIES, DEFAULT_RETRY_DELAYS, isSleepModelFailure, SleepModelFailureError } from "./llm-budget.js";
import type { SleepModelFailureReason } from "./llm-budget.js";
import { sleepStepDeadlineMs } from "./step-deadlines.js";
import { ensurePrimaryUserId } from "../user-utils.js";
import { CATCHUP_MAX_AGE_DAYS, runCatchUp } from "./catchup.js";
import { emitSleepEvent } from "./contracts.js";
import { isSleepStepEligible, sleepStepConfig, type SleepEligibilityContext } from "./sleep-manifest.js";
import type {
  SleepRunOptions,
  SleepRunResult,
  SleepFailure,
} from "./contracts.js";
import { toBoundedFailure, failureFromError } from "./failure-report.js";
import { settleSleepRun } from "./settlement.js";
import { toSummary, projectResult, alreadyRunningResult, noWorkResult } from "./result.js";

const TAG = "abmind-sleep";

/** Prompt steps that append to the daily-summary artifact. They must never
 * receive a guessed path when daily-summary was skipped or cannot be reused. */
const DAILY_ARTIFACT_STEPS = new Set(["retrospective", "skill-review"]);

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

/** Steps whose failure blocks watermark advance. Public so tests can derive reject targets. */
export { essentialSleepSteps } from "./catchup.js";

/** Thrown by runSleepCycle when memory layer fails to initialize. */
export class SleepInitError extends Error {
  constructor(message: string) { super(message); this.name = "SleepInitError"; }
}

// ── In-process concurrency guard (#1353) ────────────────────────────────────
// The durable lock file protects against another OS process using the same
// abmind home. This guards a second invocation within THIS process (e.g. two
// overlapping calls from a host that forgot to serialize). A key is the
// resolved memory directory — one run per home, per process.
const activeRunsByMemoryDir = new Set<string>();

/**
 * Run the full sleep cycle against a host-injected runtime. Returns a
 * structured SleepRunResult projected from the authoritative on-disk state —
 * hosts never need to read the lock file themselves.
 */
export async function runSleepCycle(options: SleepRunOptions): Promise<SleepRunResult> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? getAbmindEnv().sleepTimeoutMin * 60 * 1000;
  const retryDelays = options.retryDelays ?? DEFAULT_RETRY_DELAYS;
  const betweenStepBackoffMs = options.betweenStepBackoffMs ?? ((n: number) => [10, 30, 60][Math.min(n, 2)]! * 1000);
  const runtime = options.runtime;
  const startedAt = now();

  // ── Cancellation: combine caller signal + wall-clock timeout ──
  const internalController = new AbortController();
  const timeoutHandle = setTimeout(() => internalController.abort(new SleepTimeoutReason()), timeoutMs);
  const onCallerAbort = (): void => internalController.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) internalController.abort(options.signal.reason);
    else options.signal.addEventListener("abort", onCallerAbort);
  }
  const signal = internalController.signal;
  const cleanupCancellation = (): void => {
    clearTimeout(timeoutHandle);
    options.signal?.removeEventListener("abort", onCallerAbort);
  };

  const memoryConfig = options.memoryManager?.getConfig()
    ?? { ...loadMemoryConfig(), ...options.memoryConfigOverride };

  // #1353: in-process concurrency guard — claimed synchronously, before any
  // await, so two overlapping calls in the same process cannot both pass the
  // check. This protects a single process invoking runSleepCycle twice; the
  // durable PID-based lock (below) protects against a second OS process.
  const memoryDirKey = memoryConfig.memoryDir;
  if (activeRunsByMemoryDir.has(memoryDirKey)) {
    cleanupCancellation();
    return alreadyRunningResult(startedAt, now());
  }
  activeRunsByMemoryDir.add(memoryDirKey);

  const ownsMemory = options.memoryManager === undefined;
  const memory = options.memoryManager ?? new MemoryManager(memoryConfig);

  if (ownsMemory) {
    try {
      await memory.initialize();
    } catch (err) {
      activeRunsByMemoryDir.delete(memoryDirKey);
      cleanupCancellation();
      throw new SleepInitError(`Failed to initialize MemoryManager: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // #1353: async, library-native preflight — no execSync, no CLI subprocess.
  try { await memory.maintenance.runPreflight(); } catch { /* non-fatal — proceed with sleep */ }

  try {
    const sleepData = memory.getSleepData();
    const db = (memory as any).db; // access DB for meta writes

    // TTL: clean ephemeral system/agent messages older than 24h
    try { db.prepare("DELETE FROM messages WHERE user_id IN ('system', 'agent') AND timestamp < ?").run(Date.now() - 86_400_000); } catch { /* */ }

    const { metaSet, metaIncrement, metaGetInt } = await import("../meta-store.js");

    metaSet(db, "sleep_last_attempt_ts", Date.now());
    metaIncrement(db, "sleep_total_runs");

    const dateStr = toDateStr(now());
    const statePath = join(memoryConfig.memoryDir, "sleep", `sleep_${dateStr}.lock`);
    const existingState = readStateFile(statePath);

    // #518 + #1353: durable PID guard — protects against another OS process
    // using the same abmind home.
    if (existingState?.status === "ongoing") {
      let alive = false;
      try { process.kill(existingState.pid, 0); alive = true; } catch {}
      if (alive) {
        logInfo(TAG, `[SLEEP] Already running (pid ${existingState.pid}) — skipping`);
        return alreadyRunningResult(startedAt, now());
      }
      logWarn(TAG, `[SLEEP] Stale lock (pid ${existingState.pid} dead) — claiming`);
    }

    // Fresh cycle discards prior state (budget + steps) — #1752 uses shared resumability predicate
    const isPidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const isResume = !options.fresh && existingState !== null && isResumableSleepState(existingState, isPidAlive);
    const priorRunId = existingState?.runId;
    const runId = options.runId ?? randomUUID();

    // #1608: canonical sleep identity. ABMIND_USER_ID wins when explicitly
    // supplied; otherwise initialize it from the saved manifest.json
    // encryptionUser. Never guess from DB row order — fail clearly when
    // nothing is configured.
    const primaryUserId = ensurePrimaryUserId();
    if (!primaryUserId) {
      throw new Error(
        "Primary user identity is not configured: ABMIND_USER_ID is not set and no encryptionUser is saved in manifest.json. " +
          "Set ABMIND_USER_ID, or re-run abmind install to persist the identity, before running sleep.",
      );
    }

    const totalStepsForEvent = loadSleepSteps().length;
    emitSleepEvent(options.onEvent, { type: "cycle_started", runId, totalSteps: totalStepsForEvent, resumed: isResume });

    // Gather state
    const gatherer = new SleepStateGatherer(memory, memoryConfig, undefined);
    const snapshot = await gatherer.gather(primaryUserId);

    // Guardrail: skip if no messages since last sleep (unless resuming)
    const msgCount = snapshot.dbStats.messagesSinceLastSleep;
    // #1353: manual runs (e.g. "/sleep now") still run housekeeping even with
    // zero new messages — matches the previous flags.force escape hatch.
    const forceHousekeeping = options.mode === "manual";
    if (msgCount === 0 && !isResume && !forceHousekeeping) {
      logInfo(TAG, `[SLEEP] No messages since last sleep — nothing to process.`);
      const sleepDir = join(memoryConfig.memoryDir, "sleep");
      mkdirSync(sleepDir, { recursive: true });
      const noWorkDateStr = localDate().replace(/-/g, "");
      const timeStr = new Date().toTimeString().slice(0, 5).replace(/:/g, "");
      writeFileSync(join(sleepDir, `sleep_${noWorkDateStr}_${timeStr}.md`), `# Sleep Audit Log\n\n## No work — 0 messages since last sleep\n`, "utf-8");
      const result = noWorkResult(runId, startedAt, now());
      emitSleepEvent(options.onEvent, { type: "cycle_finished", runId, result });
      return result;
    }

    // Wired pre-tasks (always run — fast, idempotent, abmind-owned only)
    logInfo(TAG, `[SLEEP] Running wired pre-tasks${isResume ? " (resume)" : ""}...`);
    const wiredResults = await runWiredPreTasks(sleepData, memoryConfig.memoryDir, memory, primaryUserId);
    logInfo(TAG, `[SLEEP] Wired: ${formatWiredResults(wiredResults)}`);

    const candidates = sleepData.buildSleepCandidates(getAbmindEnv().sleepModelName ?? "unknown", primaryUserId);

    const vars = buildSleepVars(snapshot);
    vars.WIRED_RESULTS = formatWiredResults(wiredResults);
    vars.UNTAGGED_MEMORIES = candidates.untaggedMemories || "No untagged memories found.";
    vars.PROMOTION_CANDIDATES = candidates.promotionCandidates || "No promotion candidates found.";
    vars.CONTRADICTION_WARNINGS = candidates.contradictions || "";
    vars.MERGE_CANDIDATES = candidates.mergeCandidates || "No merge candidates found.";
    vars.TRANSLATION_ISSUES = candidates.translationIssues || "No translation issues found.";
    vars.EMOTION_CONTEXT_GAPS = candidates.emotionContextGaps || "No emotion context gaps found.";
    vars.RECALL_FEEDBACK = candidates.recallFeedback || "No recalls happened today.";

    {
      const { detectSkillDuplicates, formatDedupCandidates, resolveSkillCatalog, SKILL_CATALOG_UNAVAILABLE } = await import("./skill-dedup.js");
      const catalog = resolveSkillCatalog(options.skillCatalogDirs);
      if (catalog.state === "ready") {
        const dedupCandidates = detectSkillDuplicates(catalog.coreSkillsDir, catalog.selfSkillsDir);
        vars.DEDUP_CANDIDATES = formatDedupCandidates(dedupCandidates) || "No skill duplicates or overlaps detected.";
      } else {
        vars.DEDUP_CANDIDATES = SKILL_CATALOG_UNAVAILABLE;
      }
    }
    vars.RESUME_CONTEXT = isResume
      ? `This is a RESUMED sleep cycle. Steps already completed: ${Object.entries(existingState!.steps).filter(([, s]) => s.status === "ok" || s.status === "skipped").map(([k]) => k).join(", ")}. Only pending/failed steps will run.`
      : "Fresh sleep cycle — all steps will run.";

    const lastSleepTs = snapshot.lastSleepTimestamp ?? 0;
    // #1807: run-local GC compatibility diagnostic. Set once when the
    // artifact is incompatibly shaped; attached to the domain report even
    // when GC model dispatch is ineligible. Never carries file contents.
    let gcDiagnostic: string | null = null;
    const noteGcIncompatible = (detail: string): void => {
      if (!gcDiagnostic) {
        gcDiagnostic = `GC artifact ${join(memoryConfig.memoryDir, "garbage.json")} is incompatibly shaped (${detail}) — left unchanged, no GC deletion authorized; operator reconciliation required.`;
        logWarn(TAG, `[SLEEP] ${gcDiagnostic}`);
      }
    };
    try {
      const gcStatus = readGcMarks(memoryConfig.memoryDir);
      const garbageIds = new Set<number>();
      if (gcStatus.kind === "ok") {
        for (const id of gcStatus.marks.keys()) garbageIds.add(id);
      } else if (gcStatus.kind === "incompatible") {
        noteGcIncompatible(gcStatus.detail);
      }

      const msgs = sleepData.getMessagesAfter(lastSleepTs, sleepData.getPrimaryUserId());
      const lines = msgs
        .filter(m => !garbageIds.has(m.id) && !m.content.startsWith("[SYSTEM"))
        // #1515: strip the storage-only wake-up marker while retaining the
        // assistant question in chronological context beside the user's reply.
        .map(m => `[${m.role}]${m.emotion_score ? ` (emotion:${m.emotion_score})` : ""} ${m.content.replace(/^\[WAKE-UP QUESTION id=[^\]]+\]\s*/, "").slice(0, 500)}`);

      vars.CLEAN_MESSAGES = lines.length > 0
        ? `${lines.length} messages since last sleep:\n\n${lines.join("\n")}`
        : "No messages since last sleep.";
      logInfo(TAG, `[SLEEP] Pre-queried ${lines.length} messages for retro (${msgs.length} total, ${garbageIds.size} garbage filtered)`);
    } catch { vars.CLEAN_MESSAGES = "Error loading messages — use abmind recall to search."; }

    vars.MESSAGES_SINCE_WATERMARK = vars.CLEAN_MESSAGES;
    // DAILY_PATH/RETRO_PATH are intentionally unbound until daily-summary
    // writes an artifact or a valid resume checkpoint supplies its exact path.
    // #1807: previous-consolidation discovery is resolved just before the
    // consolidation dispatch (see the per-step preparation below), never as
    // start-of-run prose in a path variable.

    const todayIso = new Date(now()).toISOString().slice(0, 10);
    const weeklyDir = join(memoryConfig.memoryDir, "weekly");
    const quarterlyDir = join(memoryConfig.memoryDir, "quarterly");
    mkdirSync(weeklyDir, { recursive: true });
    mkdirSync(quarterlyDir, { recursive: true });
    const month = new Date(now()).getMonth();
    const isQuarterBoundary = month % 3 === 0 && new Date(now()).getDate() <= 7;
    vars.CONSOLIDATION_OUTPUT_PATH = isQuarterBoundary
      ? join(quarterlyDir, `quarterly_${todayIso}.md`)
      : join(weeklyDir, `weekly_${todayIso}.md`);

    const steps = loadSleepSteps();
    const snapshotVars = buildSleepVars(snapshot);
    for (const [k, v] of Object.entries(snapshotVars)) vars[k] = vars[k] ?? v;

    const totalSteps = steps.length;
    let stepIndex = 0;

    // Eligibility — one manifest-backed predicate over a gathered context.
    const quality: Level = options.level ?? (getAbmindEnv().sleepQuality ? parseLevel(getAbmindEnv().sleepQuality!) : DEFAULT_LEVEL);
    const curationDay = getAbmindEnv().sleepCurationDay;
    const today = new Date(now()).toLocaleDateString("en", { weekday: "long" }).toLowerCase();
    const isCurationDay = today === curationDay;

    const eligibility: SleepEligibilityContext = {
      level: quality,
      isCurationDay,
      hasShortMessages: (() => { try { return sleepData.getShortMessageCount() > 0; } catch { return true; } })(),
      hasRecallFeedback: !!candidates.recallFeedback,
      hasMaintenanceCandidates: !!(candidates.untaggedMemories || candidates.mergeCandidates || candidates.emotionContextGaps),
      hasTranslationIssues: !!candidates.translationIssues,
      extractedMemoryCount: snapshot.dbStats.extractedMemoryCount,
    };
    const eligibleStepNames = steps.filter(s => isSleepStepEligible(s, eligibility)).map(s => s.name);
    logInfo(TAG, `[SLEEP] Quality=${quality}${isCurationDay ? " (curation day)" : ""} — ${eligibleStepNames.length}/${steps.length} steps eligible (${eligibleStepNames.join(", ")})`);

    // Initialize state file with the new run identity.
    const state: SleepState = existingState ?? {
      status: "ongoing",
      pid: process.pid,
      runId,
      startedAt: now(),
      llmCalls: 0,
      wiredResults,
      steps: {},
    };
    state.status = "ongoing";
    state.pid = process.pid;
    state.runId = runId;
    if (priorRunId) state.priorRunId = priorRunId;
    state.wiredResults = wiredResults;

    const modelUsed = getAbmindEnv().sleepModelName;
    let dailySummaryPath: string | null = null;
    let retrospectiveBeforeContent: string | null = null;
    // #1807: run-local GC selection state. Valid IDs shown to the gc-noise
    // model this cycle; the validated current-cycle selection reserved for
    // the post-success flush (never reconstructed from all marks on resume).
    let gcValidIds: Set<number> | null = null;
    let gcCycleSelection: number[] | null = null;
    // #1752 R7: recover daily path from checkpoint for resume before any prompt-driven step
    if (isResume && existingState?.steps["daily-summary"]?.status === "ok") {
      const prior = existingState.steps["daily-summary"]?.path;
      if (prior && readDailyArtifact(prior).usable) {
        dailySummaryPath = prior;
        vars.DAILY_PATH = vars.RETRO_PATH = prior;
        logInfo(TAG, `[SLEEP] recovered daily path from lock (${prior})`);
      } else if (prior) {
        logWarn(TAG, `[SLEEP] daily artifact missing or unusable (${prior}) — retrospective will be skipped, review will downgrade daily-summary`);
      }
    }
    let cancelled = false;
    // #1653: run-local accepted output length per step — the review's
    // budget_without_output fact. Records domain output only (summary text,
    // extraction response, accepted step response); no StepResult field.
    const acceptedOutputChars = new Map<string, number>();
    // #1515: step-05 evidence snapshots for clarification-candidate
    // authorization — role-specific id -> semantic_revision maps for exactly
    // the rows rendered into NEW_EXTRACTIONS / CONTRADICTION_CANDIDATES, plus
    // a separately queried primary-user current-run ID set and one captured
    // preparation time. Local to this attempt; never persisted.
    const newEvidenceRevisions = new Map<number, number>();
    const existingEvidenceRevisions = new Map<number, number>();
    const currentRunNewIds = new Set<number>();
    let step05PreparedAt = 0;

    // #1611/#1752: one terminal model failure stops the sleep. Recorded
    // exactly once (the recorder exits the step loop), it forces terminal
    // status "failed", keeps the run resumable, advances no watermark, and is
    // the only source of the actionable report line. Catch-up returns its
    // typed failure here instead of throwing through the service seam.
    let terminalModelFailure: { stepId: string; reason: SleepModelFailureReason; failure: SleepFailure } | null = null;

    const statusForModelFailure = (reason: SleepModelFailureReason): "timeout" | "failed" =>
      reason === "step_deadline" || reason === "provider_timeout" ? "timeout" : "failed";

    /** Mark the current step with its stable terminal reason, emit exactly one
     *  step_failed event, and stop the sleep. The caller breaks the step loop. */
    const recordTerminalFailure = (stepName: string, reason: SleepModelFailureReason, durationMs: number, failure?: SleepFailure): void => {
      const essential = sleepStepConfig(stepName)?.essential ?? false;
      const causeFailure = failure ?? toBoundedFailure(reason, undefined);
      terminalModelFailure = { stepId: stepName, reason, failure: causeFailure };
      state.steps[stepName] = { status: statusForModelFailure(reason), essential, duration: Math.round(durationMs / 100) / 10, failure: causeFailure };
      writeStateFile(statePath, state);
      emitSleepEvent(options.onEvent, { type: "step_failed", runId, step: toSummary(stepName, statusForModelFailure(reason), essential, state.steps[stepName]) });
    };

    // Captured before the daily-summary step reads messages, so a message
    // arriving mid-cycle is preserved for the next run. Re-summarizing one
    // message is acceptable; skipping one is not (#1603).
    const watermarkTargetTs = now();

    /** Persist a checkpoint-safe cancellation marker and record the reason. */
    const persistCancelled = (): void => {
      state.status = "suspended";
      writeStateFile(statePath, state);
      cancelled = true;
    };

    // #1653: the pre-settlement review needs the run-local per-step budget
    // attribution — declared here so it survives the step-loop scope.
    let budget: LlmBudget | undefined;

    try {
      if (isResume) {
        const completedCount = Object.values(state.steps).filter(s => s.status === "ok").length;
        state.llmCalls = completedCount;
      }
      budget = new LlmBudget(state, statePath);

      // Checkpoint boundary: before preflight/wired maintenance already ran above.
      if (signal.aborted) { persistCancelled(); }

      if (!cancelled) {
        const sleepDir = join(memoryConfig.memoryDir, "sleep");
        const previousLocks = scanPreviousLocks(sleepDir, dateStr);
        if (previousLocks.length > 0) {
          logInfo(TAG, `[CATCH-UP] Found ${previousLocks.length} previous lock(s)`);
          const catchUpFailure = await runCatchUp(previousLocks, sleepData, memoryConfig, steps, runtime, runId, signal, budget, retryDelays, options.onEvent);
          if (catchUpFailure) terminalModelFailure = catchUpFailure;
        }
      }

      // Housekeeping: move misplaced daily/consolidation_* to weekly/ (#640)
      try {
        const dailyDir = join(memoryConfig.memoryDir, "daily");
        if (existsSync(dailyDir)) {
          for (const f of readdirSync(dailyDir).filter(fn => fn.startsWith("consolidation_"))) {
            const m = f.match(/consolidation_(\d{4})-(\d{2})-week(\d)/);
            if (m) {
              const [, year, month2, week] = m;
              const day = (parseInt(week!) - 1) * 7 + 1;
              const approxDate = `${year}-${month2}-${String(Math.min(day, 28)).padStart(2, "0")}`;
              const dest = join(weeklyDir, `weekly_${approxDate}.md`);
              if (!existsSync(dest)) {
                const { renameSync } = await import("node:fs");
                renameSync(join(dailyDir, f), dest);
                logInfo(TAG, `[HOUSEKEEPING] Moved ${f} → weekly_${approxDate}.md`);
              }
            }
          }
        }
      } catch (err) { logWarn(TAG, `[HOUSEKEEPING] consolidation migration failed: ${err}`); }

      let consecutiveFailures = 0;
      const stepLogDir = join(sleepDir(memoryConfig.memoryDir), dateStr);
      mkdirSync(stepLogDir, { recursive: true });

      const userSoul = join(memoryConfig.memoryDir, "..", "prompts", "sleep", "SOUL-Dreamy.md");
      const pkgSoul = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts", "sleep", "SOUL-Dreamy.md");
      const soulPath = existsSync(userSoul) ? userSoul : pkgSoul;
      let soulPrefix = existsSync(soulPath) ? readFileSync(soulPath, "utf-8") + "\n\n---\n\n" : "";

      for (const step of steps) {
        if (cancelled || terminalModelFailure) break;

        // Checkpoint boundary: before each step's model/mutation work.
        if (signal.aborted) { persistCancelled(); break; }

        if (budget.exhausted) {
          logWarn(TAG, `[BUDGET] Suspending sleep — ${budget.calls}/${getAbmindEnv().sleepMaxLlmCalls} LLM calls used`);
          state.status = "suspended";
          writeStateFile(statePath, state);
          break;
        }

        stepIndex++;
        const essential = step.essential;
        emitSleepEvent(options.onEvent, { type: "step_started", runId, stepId: step.name, index: stepIndex, total: totalSteps });

        // #1611: one absolute deadline per logical step, established before
        // any subcall. Same-model retries reuse it — the clock never restarts.
        const stepDeadlineAt = now() + sleepStepDeadlineMs(step.name);

        if (isResume && existingState?.steps[step.name]?.status === "ok") {
          logInfo(TAG, `[SLEEP] ⏭ ${step.name} — already done (resume)`);
          emitSleepEvent(options.onEvent, { type: "step_skipped", runId, step: toSummary(step.name, "skipped", essential, existingState.steps[step.name]) });
          continue;
        }
        if (isResume && existingState?.steps[step.name]?.status === "skipped") {
          logInfo(TAG, `[SLEEP] ⏭ ${step.name} — skipped (resume)`);
          emitSleepEvent(options.onEvent, { type: "step_skipped", runId, step: toSummary(step.name, "skipped", essential, existingState.steps[step.name]) });
          continue;
        }

        if (!isSleepStepEligible(step, eligibility)) {
          logInfo(TAG, `[SLEEP] ⏭ ${step.name} — skipped`);
          state.steps[step.name] = { status: "skipped", essential };
          writeStateFile(statePath, state);
          emitSleepEvent(options.onEvent, { type: "step_skipped", runId, step: toSummary(step.name, "skipped", essential, state.steps[step.name]) });
          continue;
        }

        const start = Date.now();
        logInfo(TAG, `[SLEEP] → ${step.name}`);
        state.steps[step.name] = { status: "pending", essential };
        writeStateFile(statePath, state);

        // Code-driven steps
        if (step.name === "daily-summary") {
          try {
            const ctxWindow = getAbmindEnv().sleepCtxWindow;
            const userId = sleepData.getPrimaryUserId();
            const watermarkTs = sleepData.getExtractionWatermark(userId);

            const result = await buildDailySummary(sleepData.getDb(), (p) => sendToRuntime(runtime, p, "daily-summary", runId, signal, stepDeadlineAt, budget, retryDelays, now).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }), {
              ctxWindow, memoryDir: memoryConfig.memoryDir, userId, watermarkTs,
            });
            if (result) {
              // #1821: the filename is the write instant; the covered window
              // reported by the build owns the heading.
              dailySummaryPath = writeDailyFile(memoryConfig.memoryDir, result.startTs, result.endTs, result.summary);
              // #1752 R7: bind actual write path before retrospective substitution; covers non-current dated summaries
              vars.DAILY_PATH = vars.RETRO_PATH = dailySummaryPath;
              acceptedOutputChars.set("daily-summary", result.summary.length);
              state.steps[step.name] = { status: "ok", essential, duration: Math.round((Date.now() - start) / 100) / 10, path: dailySummaryPath };
              writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${step.name}.md`), redactSecrets(result.summary), "utf-8");
            } else {
              state.steps[step.name] = { status: "skipped", essential };
            }
          } catch (err) {
            if (isSleepModelFailure(err)) {
              const ev = (err as unknown as { evidence?: unknown[] }).evidence;
              if (ev && Array.isArray(ev) && ev.length > 0) persistEmptyEvidence(stepLogDir, stepIndex, step.name, ev);
              logWarn(TAG, `[SLEEP] ${step.name} — terminal model failure (${err.reason}), stopping sleep (not advancing to next phase)`);
              recordTerminalFailure(step.name, err.reason, Date.now() - start, failureFromError(err, "unknown"));
              break;
            }
            logWarn(TAG, `[SLEEP] daily-summary failed: ${err instanceof Error ? err.message : String(err)}`);
            const failure = failureFromError(err, "unknown");
            state.steps[step.name] = { status: "failed", essential, duration: Math.round((Date.now() - start) / 100) / 10, failure };
            writeStateFile(statePath, state);
            emitSleepEvent(options.onEvent, { type: "step_failed", runId, step: toSummary(step.name, "failed", essential, state.steps[step.name]) });
          }
          if (state.steps[step.name]?.status !== "failed") {
            writeStateFile(statePath, state);
            const s = state.steps[step.name]!;
            emitSleepEvent(options.onEvent, s.status === "ok"
              ? { type: "step_completed", runId, step: toSummary(step.name, "completed", essential, s) }
              : { type: "step_skipped", runId, step: toSummary(step.name, "skipped", essential, s) });
          }
          logInfo(TAG, `[SLEEP] ${state.steps[step.name]?.status === "ok" ? "✓" : "✗"} ${step.name} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
          continue;
        }

        if (step.name === "extract-memories") {
          if (!dailySummaryPath) {
            state.steps[step.name] = { status: "skipped", essential };
            writeStateFile(statePath, state);
            logInfo(TAG, `[SLEEP] ⏭ ${step.name} — no daily summary`);
            emitSleepEvent(options.onEvent, { type: "step_skipped", runId, step: toSummary(step.name, "skipped", essential, state.steps[step.name]) });
            continue;
          }
          try {
            const userId = sleepData.getPrimaryUserId();
            const result = await extractFromDaily(dailySummaryPath, userId, (p) => sendToRuntime(runtime, p, "extract-memories", runId, signal, stepDeadlineAt, budget, retryDelays, now).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }));
            acceptedOutputChars.set("extract-memories", result.trim().length);
            state.steps[step.name] = { status: "ok", essential, duration: Math.round((Date.now() - start) / 100) / 10 };
            writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${step.name}.md`), redactSecrets(result), "utf-8");
            logInfo(TAG, `[SLEEP] ✓ ${step.name} (${((Date.now() - start) / 1000).toFixed(1)}s) — ${result.slice(0, 80)}`);
          } catch (err) {
            if (isSleepModelFailure(err)) {
              const ev = (err as unknown as { evidence?: unknown[] }).evidence;
              if (ev && Array.isArray(ev) && ev.length > 0) persistEmptyEvidence(stepLogDir, stepIndex, step.name, ev);
              logWarn(TAG, `[SLEEP] ${step.name} — terminal model failure (${err.reason}), stopping sleep (not advancing to next phase)`);
              recordTerminalFailure(step.name, err.reason, Date.now() - start, failureFromError(err, "unknown"));
              break;
            }
            logWarn(TAG, `[SLEEP] extract-memories failed: ${err instanceof Error ? err.message : String(err)}`);
            const failure = failureFromError(err, "unknown");
            state.steps[step.name] = { status: "failed", essential, duration: Math.round((Date.now() - start) / 100) / 10, failure };
            writeStateFile(statePath, state);
            emitSleepEvent(options.onEvent, { type: "step_failed", runId, step: toSummary(step.name, "failed", essential, state.steps[step.name]) });
          }
          if (state.steps[step.name]?.status !== "failed") {
            writeStateFile(statePath, state);
            emitSleepEvent(options.onEvent, { type: "step_completed", runId, step: toSummary(step.name, "completed", essential, state.steps[step.name]!) });
          }
          continue;
        }

        // Standard prompt-driven step — JIT substitution
        if (step.name === "contradiction-and-graph") {
          try {
            const todayStart = new Date(now());
            todayStart.setHours(0, 0, 0, 0);
            const newRows = sleepData.getContradictionEvidence(primaryUserId, todayStart.getTime());
            if (newRows.length === 0) {
              state.steps[step.name] = { status: "skipped", essential };
              writeStateFile(statePath, state);
              logInfo(TAG, `[SLEEP] ⏭ ${step.name} — no new extractions today`);
              emitSleepEvent(options.onEvent, { type: "step_skipped", runId, step: toSummary(step.name, "skipped", essential, state.steps[step.name]) });
              continue;
            }
            vars.NEW_EXTRACTIONS = newRows.map(r => `[id=${r.id}] (${r.memory_type}, trust=${r.trust}) ${r.content_en}`).join("\n");
            for (const r of newRows) newEvidenceRevisions.set(r.id, r.semantic_revision);
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
            for (const m of candidateRows) existingEvidenceRevisions.set(m.id, m.semantic_revision);
            vars.CONTRADICTION_CANDIDATES = candidateRows.length > 0
              ? candidateRows.map(r => `[id=${r.id}] (${r.memory_type}, trust=${r.trust}, cred=${r.credibility}) ${r.content_en}`).join("\n")
              : "No existing memories with overlapping content found.";
            // #1515: current-run attribution — bounded inference over the
            // primary user's non-observation rows in the run window that were
            // actually rendered into NEW_EXTRACTIONS. Bound parameters only;
            // skipped entirely when nothing new was rendered.
            if (newEvidenceRevisions.size > 0) {
              step05PreparedAt = now();
              const newIds = [...newEvidenceRevisions.keys()];
              const currentRows = sleepData.getCurrentRunNewIds(primaryUserId, state.startedAt, step05PreparedAt, newIds);
              for (const cr of currentRows) currentRunNewIds.add(cr);
            }
          } catch (err) {
            logWarn(TAG, `[SLEEP] contradiction-and-graph var prep failed: ${err instanceof Error ? err.message : String(err)}`);
            state.steps[step.name] = { status: "skipped", essential };
            writeStateFile(statePath, state);
            emitSleepEvent(options.onEvent, { type: "step_skipped", runId, step: toSummary(step.name, "skipped", essential, state.steps[step.name]) });
            continue;
          }
        }

        if (step.name === "rem-synthesis") {
          try {
            const sample = sleepData.getRemSample(primaryUserId, 10);
            if (sample.length < 5) {
              state.steps[step.name] = { status: "skipped", essential };
              writeStateFile(statePath, state);
              logInfo(TAG, `[SLEEP] ⏭ ${step.name} — not enough memories for REM`);
              emitSleepEvent(options.onEvent, { type: "step_skipped", runId, step: toSummary(step.name, "skipped", essential, state.steps[step.name]) });
              continue;
            }
            vars.REM_SAMPLE = sample.map(r => `[${r.memory_type}, ${new Date(r.created_at).toISOString().slice(0, 10)}] ${r.content_en}`).join("\n");
          } catch {
            state.steps[step.name] = { status: "skipped", essential };
            writeStateFile(statePath, state);
            emitSleepEvent(options.onEvent, { type: "step_skipped", runId, step: toSummary(step.name, "skipped", essential, state.steps[step.name]) });
            continue;
          }
        }

        // #1752 R7: retrospective requires a readable daily artifact; skip when legitimately absent and avoid misreporting as model failure
        if (step.name === "retrospective") {
          let effectivePath: string | null = dailySummaryPath;
          if (!effectivePath) {
            const dailyStatus = state.steps["daily-summary"]?.status ?? "missing";
            logInfo(TAG, `[SLEEP] ⏭ retrospective — no daily summary artifact (daily-summary: ${dailyStatus})`);
            state.steps[step.name] = { status: "skipped", essential };
            writeStateFile(statePath, state);
            emitSleepEvent(options.onEvent, { type: "step_skipped", runId, step: toSummary(step.name, "skipped", essential, state.steps[step.name]) });
            continue;
          }
          const artifact = readDailyArtifact(effectivePath);
          if (!artifact.usable) {
            logWarn(TAG, `[SLEEP] ⏭ retrospective — daily artifact missing or unusable (${effectivePath}) — leaving daily-summary for review`);
            state.steps[step.name] = { status: "skipped", essential };
            writeStateFile(statePath, state);
            emitSleepEvent(options.onEvent, { type: "step_skipped", runId, step: toSummary(step.name, "skipped", essential, state.steps[step.name]) });
            continue;
          }
          retrospectiveBeforeContent = readDailyArtifactRaw(effectivePath);
          if (retrospectiveBeforeContent === null) {
            logWarn(TAG, `[SLEEP] ⏭ retrospective — daily artifact became unreadable (${effectivePath})`);
            state.steps[step.name] = { status: "skipped", essential };
            writeStateFile(statePath, state);
            emitSleepEvent(options.onEvent, { type: "step_skipped", runId, step: toSummary(step.name, "skipped", essential, state.steps[step.name]) });
            continue;
          }
          vars.DAILY_PATH = vars.RETRO_PATH = effectivePath;
          dailySummaryPath = effectivePath;
        }

        // #1752 R7: skill-review also appends to DAILY_PATH. Unlike
        // retrospective, it has no dedicated dependency branch above, so
        // guard it here before prompt substitution when no artifact exists.
        if (DAILY_ARTIFACT_STEPS.has(step.name) && !dailySummaryPath) {
          logInfo(TAG, `[SLEEP] ⏭ ${step.name} — no daily summary artifact`);
          state.steps[step.name] = { status: "skipped", essential };
          writeStateFile(statePath, state);
          emitSleepEvent(options.onEvent, { type: "step_skipped", runId, step: toSummary(step.name, "skipped", essential, state.steps[step.name]) });
          continue;
        }

        // #1807: step-specific input preparation just before dispatch.
        // Stable roots were resolved once per run; step-dependent resources
        // (GC marks, retrospective artifact, daily selection) refresh here so
        // earlier steps' output is visible to later preparation.
        if (step.name === "gc-noise") {
          try {
            const gcMsgs = sleepData.getMessagesAfter(lastSleepTs, sleepData.getPrimaryUserId())
              .filter(m => !m.content.startsWith("[SYSTEM"));
            gcValidIds = new Set(gcMsgs.map(m => m.id));
            vars.GC_MESSAGES = gcMsgs.length > 0
              ? gcMsgs.map(m => `[id:${m.id}] [${m.role}] ${m.content.slice(0, 300)}`).join("\n")
              : "No messages since last sleep — respond with [].";
          } catch {
            gcValidIds = new Set();
            vars.GC_MESSAGES = "Message query failed — respond with [].";
          }
        }

        if (step.name === "retro-derive") {
          const files = knowledgeFileInputs(memoryConfig.memoryDir);
          const availability = knowledgeAvailabilitySection(files);
          for (const f of files) {
            vars[f.name.replace(/\.md$/, "").toUpperCase() + "_PATH"] = f.path;
          }
          vars.KNOWLEDGE_AVAILABILITY = availability.section;
          const retroRaw = dailySummaryPath ? readDailyArtifactRaw(dailySummaryPath) : null;
          vars.RETRO_CONTENT = retroRaw ?? RETRO_ABSENT_MARKER;
        }

        if (step.name === "consolidation") {
          const quarterly = vars.CONSOLIDATION_OUTPUT_PATH.startsWith(join(memoryConfig.memoryDir, "quarterly"));
          const selection = consolidationInputs(memoryConfig.memoryDir, new Date(now()), quarterly);
          vars.DAILY_INPUT_LIST = selection.listSection;
          vars.COVERED_RANGE = selection.coveredRange;
          vars.MISSING_DATES = selection.missingDates.length > 0
            ? selection.missingDates.join(", ")
            : "none — full coverage.";
          try {
            const { getLatestConsolidationFile } = await import("../consolidation-search.js");
            const tier = quarterly ? "quarterly" : "weekly";
            const latest = getLatestConsolidationFile(memoryConfig.memoryDir, tier);
            vars.PREVIOUS_CONSOLIDATION_SECTION = previousConsolidationSection(latest?.filePath ?? null);
          } catch {
            vars.PREVIOUS_CONSOLIDATION_SECTION = previousConsolidationSection(null);
          }
          if (selection.selected.length === 0) {
            logInfo(TAG, `[SLEEP] ⏭ consolidation — no daily artifacts in range`);
            state.steps[step.name] = { status: "skipped", essential };
            writeStateFile(statePath, state);
            emitSleepEvent(options.onEvent, { type: "step_skipped", runId, step: toSummary(step.name, "skipped", essential, state.steps[step.name]) });
            continue;
          }
        }

        // #1807: shared preparation boundary — validate template bindings
        // before dispatch. A preparation failure is a step-level service
        // diagnostic following essential/non-essential rules; it never
        // triggers provider quarantine or consumes a provider call.
        const prepared = prepareStepDispatch(step.name, step.rawPrompt, vars);
        if (prepared.status !== "ready") {
          if (prepared.status === "no_work") {
            logInfo(TAG, `[SLEEP] ⏭ ${step.name} — ${prepared.reason}`);
            state.steps[step.name] = { status: "skipped", essential };
          } else {
            const failure = toBoundedFailure("service_failed", prepared.detail);
            logWarn(TAG, `[SLEEP] ${step.name} — preparation failed: ${prepared.detail}`);
            state.steps[step.name] = { status: "failed", essential, duration: 0, failure };
          }
          writeStateFile(statePath, state);
          emitSleepEvent(options.onEvent, {
            type: state.steps[step.name]!.status === "skipped" ? "step_skipped" : "step_failed",
            runId,
            step: toSummary(step.name, state.steps[step.name]!.status === "skipped" ? "skipped" : "failed", essential, state.steps[step.name]),
          });
          if (state.steps[step.name]!.status === "failed" && essential) break;
          continue;
        }
        const prompt = prepared.prompt;
        const fullPrompt = soulPrefix + prompt;
        if (soulPrefix) soulPrefix = "";
        let response: string | null;
        try {
          response = await sendToRuntime(runtime, fullPrompt, step.name, runId, signal, stepDeadlineAt, budget, retryDelays, now);
        } catch (err) {
          if (isSleepModelFailure(err)) {
            const evidence = (err as unknown as { evidence?: unknown[] }).evidence;
            if (evidence && Array.isArray(evidence) && evidence.length > 0) {
              persistEmptyEvidence(stepLogDir, stepIndex, step.name, evidence);
            }
            // #1752 R9: retrospective empty but artifact present — work was done via tools; don't fail step for missing closing prose
            if (step.name === "retrospective" && (err as SleepModelFailureError).reason === "invalid_response") {
              const effectivePath = dailySummaryPath;
              if (effectivePath && retrospectiveBeforeContent !== null && hasAppendedDailyArtifact(effectivePath, retrospectiveBeforeContent)) {
                logInfo(TAG, `[SLEEP] retrospective empty response but artifact was appended (${effectivePath}) — marking ok per R9`);
                const appended = readDailyArtifactRaw(effectivePath);
                acceptedOutputChars.set("retrospective", Math.max(1, (appended?.length ?? 0) - retrospectiveBeforeContent.length));
                state.steps[step.name] = { status: "ok", essential, duration: Math.round((Date.now() - start) / 100) / 10 };
                writeStateFile(statePath, state);
                emitSleepEvent(options.onEvent, { type: "step_completed", runId, step: toSummary(step.name, "completed", essential, state.steps[step.name]!) });
                continue;
              }
            }
            // #1752 R11: invalid_response on non-essential step must not terminate cycle
            const isEssential = sleepStepConfig(step.name)?.essential ?? essential;
            if ((err as SleepModelFailureError).reason === "invalid_response" && !isEssential) {
              const failure = failureFromError(err, "unknown");
              logWarn(TAG, `[SLEEP] ${step.name} — invalid_response on non-essential step, continuing (not terminal)`);
              state.steps[step.name] = { status: "failed", essential, duration: Math.round((Date.now() - start) / 100) / 10, failure };
              writeStateFile(statePath, state);
              emitSleepEvent(options.onEvent, { type: "step_failed", runId, step: toSummary(step.name, "failed", essential, state.steps[step.name]!) });
              continue;
            }
            logWarn(TAG, `[SLEEP] ${step.name} — terminal model failure (${(err as SleepModelFailureError).reason}), stopping sleep (not advancing to next phase)`);
            recordTerminalFailure(step.name, (err as SleepModelFailureError).reason, Date.now() - start, failureFromError(err, "unknown"));
            break;
          }
          throw err;
        }
        const duration = Date.now() - start;

        // Checkpoint boundary: after the awaited call, before applying its output.
        if (signal.aborted) { persistCancelled(); break; }

        if (response) {
          acceptedOutputChars.set(step.name, response.length);
          state.steps[step.name] = { status: "ok", essential, duration: Math.round(duration / 100) / 10 };
          writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${step.name}.md`), redactSecrets(response), "utf-8");
          vars[step.name.toUpperCase().replace(/-/g, "_") + "_OUTPUT"] = response;
          // #1807: retro-derive consumes the persisted artifact, not the
          // closing message. A "done"-only reply still yields full content.
          if (step.name === "retrospective") {
            vars.RETRO_CONTENT = (dailySummaryPath ? readDailyArtifactRaw(dailySummaryPath) : null) ?? response;
          }

          // #1807: GC selection is code-owned. Parse the JSON array, validate
          // every ID against the supplied set, persist atomically. Model prose
          // is not success evidence; persistence must succeed first.
          if (step.name === "gc-noise") {
            const gcOutcome = await persistGcSelection(memoryConfig.memoryDir, response, gcValidIds ?? new Set(), now(), noteGcIncompatible);
            if (!gcOutcome.ok) {
              const failure = toBoundedFailure("service_failed", gcOutcome.detail);
              logWarn(TAG, `[SLEEP] gc-noise — selection persistence failed: ${gcOutcome.detail}`);
              state.steps[step.name] = { status: "failed", essential, duration: Math.round(duration / 100) / 10, failure };
              writeStateFile(statePath, state);
              emitSleepEvent(options.onEvent, { type: "step_failed", runId, step: toSummary(step.name, "failed", essential, state.steps[step.name]) });
              if (essential) break;
              continue;
            }
            gcCycleSelection = gcOutcome.ids;
          }

          if (step.name === "contradiction-and-graph") {
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
          }
        } else {
          // #1752 R9: retrospective empty string with satisfied artifact is not a failure — budget null/abort keeps its meaning
          if (step.name === "retrospective" && response === "" && !signal.aborted) {
            const effectivePath = dailySummaryPath;
            if (effectivePath && retrospectiveBeforeContent !== null && hasAppendedDailyArtifact(effectivePath, retrospectiveBeforeContent)) {
              logInfo(TAG, `[SLEEP] retrospective empty response but artifact was appended (${effectivePath}) — marking ok per R9`);
              const appended = readDailyArtifactRaw(effectivePath);
              acceptedOutputChars.set("retrospective", Math.max(1, (appended?.length ?? 0) - retrospectiveBeforeContent.length));
              state.steps[step.name] = { status: "ok", essential, duration: Math.round(duration / 100) / 10 };
              writeStateFile(statePath, state);
              emitSleepEvent(options.onEvent, { type: "step_completed", runId, step: toSummary(step.name, "completed", essential, state.steps[step.name]!) });
              logInfo(TAG, `[SLEEP] ✓ ${step.name} (${(duration / 1000).toFixed(1)}s, artifact satisfied despite empty response)`);
              consecutiveFailures = 0;
              if (signal.aborted) { persistCancelled(); break; }
              continue;
            }
          }
          // null: budget exhausted or caller aborted mid-call (invalid-response
          // exhaustion now raises the typed terminal error instead). Empty string
          // without artifact satisfaction reports empty/no-response, not tool diagnostic.
          const failure = toBoundedFailure(signal.aborted ? "aborted" : "unknown", signal.aborted ? "cancelled" : "no response");
          state.steps[step.name] = { status: "failed", essential, duration: Math.round(duration / 100) / 10, failure };
        }
        writeStateFile(statePath, state);

        emitSleepEvent(options.onEvent, response
          ? { type: "step_completed", runId, step: toSummary(step.name, "completed", essential, state.steps[step.name]!) }
          : { type: "step_failed", runId, step: toSummary(step.name, "failed", essential, state.steps[step.name]!) });

        logInfo(TAG, `[SLEEP] ${response ? "✓" : "✗"} ${step.name} (${(duration / 1000).toFixed(1)}s, ${response?.length ?? 0} chars)`);

        if (response) { consecutiveFailures = 0; } else { consecutiveFailures++; }
        const isEssential = essential;
        if (!isEssential) {
          const delayMs = betweenStepBackoffMs(consecutiveFailures);
          if (delayMs > 0 && consecutiveFailures > 0) {
            logInfo(TAG, `[SLEEP] Waiting ${Math.round(delayMs / 1000)}s before next step`);
            await new Promise(r => setTimeout(r, delayMs));
          }
        }

        // Checkpoint boundary: between step mutations.
        if (signal.aborted) { persistCancelled(); break; }
      }
    } finally {
      cleanupCancellation();
    }

    if (cancelled) {
      const result = projectResult(runId, "cancelled", startedAt, now(), state, /* watermarkAdvanced */ false, /* resumable */ true);
      emitSleepEvent(options.onEvent, { type: "cycle_finished", runId, result });
      return result;
    }

    // ── #1838 Part 2a: post-loop settlement (review → questions →
    // watermark/lock gate → audit → GC/wired flush → result). Single call
    // with an explicit input; order preserved in settlement.ts.
    return settleSleepRun({
      runId,
      state,
      statePath,
      budget,
      watermarkTargetTs,
      memory,
      sleepData,
      db,
      gcCycleSelection,
      gcDiagnostic,
      onEvent: options.onEvent,
      snapshot,
      vars,
      primaryUserId,
      modelUsed,
      memoryDir: memoryConfig.memoryDir,
      wiredResults,
      terminalModelFailure,
      newEvidenceRevisions,
      existingEvidenceRevisions,
      currentRunNewIds,
      acceptedOutputChars,
      stepOrder: steps.map(s => s.name),
      now,
      signal,
      startedAt,
    });
  } finally {
    activeRunsByMemoryDir.delete(memoryDirKey);
    if (ownsMemory) memory.close();
  }
}

function sleepDir(memoryDir: string): string {
  return join(memoryDir, "sleep");
}

/** Internal marker for a timeout-triggered abort (never surfaced as a public error type). */
class SleepTimeoutReason extends Error {
  constructor() { super("sleep cycle timeout"); this.name = "SleepTimeoutReason"; }
}

// CLI entry + isDirectRun removed — the standalone entry point lives in
// cli/abmind-sleep.ts. Library consumers call runSleepCycle(options) directly
// with their own SleepRuntime.
