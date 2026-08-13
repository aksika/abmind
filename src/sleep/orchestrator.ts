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
import { localISO } from "../local-time.js";
import { getAbmindEnv } from "../env-schema.js";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { MemoryManager, getMemoryDb } from "../memory-manager.js";
import { DreamQuestionStore } from "../dream-question-store.js";
import { loadMemoryConfig } from "../memory-config.js";
import { SleepStateGatherer } from "../sleep-state-gatherer.js";
import { SleepDataAccess } from "../sleep-data-access.js";
import { loadSleepSteps, buildSleepVars, substituteVars } from "../sleep-pipeline.js";
import { buildDailySummary, writeDailyFile, LLMUnavailableError } from "../sleep-pipeline.js";
import { extractFromDaily } from "../sleep-pipeline.js";
import { readDailyArtifact } from "./sleep-extract-daily.js";
import { logInfo, logWarn, logError } from "../mem-logger.js";
import { localDate } from "../local-time.js";
import type { SleepStep } from "../sleep-pipeline.js";
import { type Level, parseLevel, DEFAULT_LEVEL } from "./levels.js";
import { readStateFile, writeStateFile, runWiredPreTasks, formatWiredResults } from "./state.js";
import type { SleepState, StepResult, WiredResults } from "./state.js";
import { buildSnapshotSummary, writeAuditLog } from "./audit.js";
import { toDateStr, toIsoDate, dateStrToMs, scanPreviousLocks } from "./locks.js";
import { redactSecrets } from "../redact-secrets.js";
import { TransportUnavailableError, LlmBudget, sendToRuntime, MAX_DOMAIN_RETRIES, isSleepModelFailure } from "./llm-budget.js";
import type { SleepModelFailureReason } from "./llm-budget.js";
import { sleepStepDeadlineMs } from "./step-deadlines.js";
import { ensurePrimaryUserId } from "../user-utils.js";
import { ESSENTIAL_STEPS, CATCHUP_MAX_AGE_DAYS, failedEssentials, runCatchUp } from "./catchup.js";
import { emitSleepEvent } from "./contracts.js";
import type {
  SleepRunOptions,
  SleepRunResult,
  SleepStepSummary,
  SleepTerminalStatus,
} from "./contracts.js";

const TAG = "abmind-sleep";

/** Steps whose failure blocks watermark advance. Public so tests can derive reject targets. */
export { ESSENTIAL_STEPS } from "./catchup.js";

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
  const domainRetryDelayMs = options.domainRetryDelayMs ?? 6000;
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

    // Fresh cycle discards prior state (budget + steps)
    const isResume = !options.fresh && existingState !== null && Object.values(existingState.steps).some(s => s.status === "ok");
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
    const wiredResults = await runWiredPreTasks(sleepData, memoryConfig.memoryDir, memory);
    logInfo(TAG, `[SLEEP] Wired: ${formatWiredResults(wiredResults)}`);

    const candidates = sleepData.buildSleepCandidates(getAbmindEnv().sleepModelName ?? "unknown");

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
      const { detectSkillDuplicates, formatDedupCandidates } = await import("./skill-dedup.js");
      const abtarsHome = process.env["ABTARS_HOME"] ?? join(process.env["HOME"] ?? "", ".abtars");
      const coreSkillsDir = join(abtarsHome, "skills", "core");
      const selfSkillsDir = join(abtarsHome, "skills", "self");
      const dedupCandidates = detectSkillDuplicates(coreSkillsDir, selfSkillsDir);
      vars.DEDUP_CANDIDATES = formatDedupCandidates(dedupCandidates) || "No skill duplicates or overlaps detected.";
    }
    vars.RESUME_CONTEXT = isResume
      ? `This is a RESUMED sleep cycle. Steps already completed: ${Object.entries(existingState!.steps).filter(([, s]) => s.status === "ok" || s.status === "skipped").map(([k]) => k).join(", ")}. Only pending/failed steps will run.`
      : "Fresh sleep cycle — all steps will run.";

    const lastSleepTs = snapshot.lastSleepTimestamp ?? 0;
    try {
      const garbagePath = join(memoryConfig.memoryDir, "garbage.json");
      const garbageIds = new Set<number>();
      try {
        const raw = JSON.parse(readFileSync(garbagePath, "utf-8"));
        const entries = Array.isArray(raw) ? raw : (raw?.messages ?? []);
        for (const e of entries) { if (e?.messageId) garbageIds.add(e.messageId); }
      } catch { /* no garbage file */ }

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
    vars.RETRO_PATH = join(memoryConfig.memoryDir, "daily", `daily_${toIsoDate(now())}.md`);
    vars.DAILY_PATH = vars.RETRO_PATH;
    try {
      const { getLatestConsolidationFile } = await import("../consolidation-search.js");
      const latest = getLatestConsolidationFile(memoryConfig.memoryDir, "weekly");
      vars.CONSOLIDATION_PATH = latest?.filePath ?? "No consolidation files yet.";
    } catch { vars.CONSOLIDATION_PATH = "No consolidation files yet."; }

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

    // Skip logic — candidate-driven (empty = skip)
    const skipSet = new Set<string>();
    const quality: Level = options.level ?? (getAbmindEnv().sleepQuality ? parseLevel(getAbmindEnv().sleepQuality!) : DEFAULT_LEVEL);
    const curationDay = getAbmindEnv().sleepCurationDay;
    const today = new Date(now()).toLocaleDateString("en", { weekday: "long" }).toLowerCase();
    const isCurationDay = today === curationDay;

    const BUDGET_ONLY = new Set(["gc-noise", "daily-summary", "extract-memories"]);
    const BUDGET_CURATION = new Set([...BUDGET_ONLY, "retrospective", "retro-derive"]);
    const WEEKLY_ONLY = new Set(["memory-maintenance", "translation", "skill-review", "consolidation", "rem-synthesis"]);

    if (quality === "budget" && !isCurationDay) {
      for (const step of steps) if (!BUDGET_ONLY.has(step.name)) skipSet.add(step.name);
      logInfo(TAG, `[SLEEP] Quality=budget — only essential extraction`);
    } else if (quality === "budget" && isCurationDay) {
      for (const step of steps) if (!BUDGET_CURATION.has(step.name)) skipSet.add(step.name);
      logInfo(TAG, `[SLEEP] Quality=budget (curation day) — adds retro + derive`);
    } else if (quality === "normal" && !isCurationDay) {
      for (const name of WEEKLY_ONLY) skipSet.add(name);
      logInfo(TAG, `[SLEEP] Quality=normal — weekly prompts skipped (curation day: ${curationDay})`);
    } else if (quality === "normal" && isCurationDay) {
      logInfo(TAG, `[SLEEP] Quality=normal (curation day) — all steps`);
    } else {
      logInfo(TAG, `[SLEEP] Quality=${quality}${isCurationDay ? " (curation day)" : ""} — all eligible`);
    }

    if (!candidates.recallFeedback) skipSet.add("feedback");
    if (!candidates.untaggedMemories && !candidates.mergeCandidates && !candidates.emotionContextGaps) skipSet.add("memory-maintenance");
    if (!candidates.translationIssues) skipSet.add("translation");
    if (snapshot.topicFiles.length === 0) skipSet.add("topic-reorg");
    if (snapshot.dbStats.extractedMemoryCount < 10) { skipSet.add("memory-maintenance"); skipSet.add("darwinism"); }
    if (snapshot.dbStats.extractedMemoryCount < 20) skipSet.add("rem-synthesis");
    try { if (!existsSync(join(memoryConfig.memoryDir, "..", "received"))) skipSet.add("media-cleanup"); } catch { /* */ }
    try {
      const shortCount = sleepData.getShortMessageCount();
      if (shortCount === 0) skipSet.add("gc-noise");
    } catch { /* */ }

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

    // #1611: one terminal model failure stops the sleep. Recorded exactly
    // once (recorder exits the step loop), it forces terminal status
    // "failed", keeps the run resumable, advances no watermark, and is the
    // only source of the actionable report line.
    let terminalModelFailure: { stepId: string; reason: SleepModelFailureReason } | null = null;

    const statusForModelFailure = (reason: SleepModelFailureReason): "timeout" | "failed" =>
      reason === "step_deadline" || reason === "provider_timeout" ? "timeout" : "failed";

    /** Mark the current step with its stable terminal reason, emit exactly one
     *  step_failed event, and stop the sleep. The caller breaks the step loop. */
    const recordTerminalFailure = (stepName: string, reason: SleepModelFailureReason, durationMs: number): void => {
      terminalModelFailure = { stepId: stepName, reason };
      state.steps[stepName] = { status: statusForModelFailure(reason), essential: ESSENTIAL_STEPS.has(stepName), duration: Math.round(durationMs / 100) / 10 };
      writeStateFile(statePath, state);
      emitSleepEvent(options.onEvent, { type: "step_failed", runId, step: toSummary(stepName, statusForModelFailure(reason), ESSENTIAL_STEPS.has(stepName), state.steps[stepName]) });
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
          await runCatchUp(previousLocks, sleepData, memoryConfig, steps, runtime, runId, signal, budget, 6000, options.onEvent);
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
        if (cancelled) break;

        // Checkpoint boundary: before each step's model/mutation work.
        if (signal.aborted) { persistCancelled(); break; }

        if (budget.exhausted) {
          logWarn(TAG, `[BUDGET] Suspending sleep — ${budget.calls}/${getAbmindEnv().sleepMaxLlmCalls} LLM calls used`);
          state.status = "suspended";
          writeStateFile(statePath, state);
          break;
        }

        stepIndex++;
        const essential = ESSENTIAL_STEPS.has(step.name);
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

        if (step.skippable && skipSet.has(step.name)) {
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
            const firstMsgTs = sleepData.getFirstMessageAfter(userId, watermarkTs);
            const firstMsgDate = firstMsgTs ? new Date(firstMsgTs) : new Date(now());
            const targetDate = `${firstMsgDate.getFullYear()}-${String(firstMsgDate.getMonth() + 1).padStart(2, "0")}-${String(firstMsgDate.getDate()).padStart(2, "0")}`;

            const summary = await buildDailySummary(sleepData.getDb(), (p) => sendToRuntime(runtime, p, "daily-summary", runId, signal, stepDeadlineAt, budget, domainRetryDelayMs, now).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }), {
              ctxWindow, memoryDir: memoryConfig.memoryDir, userId, watermarkTs,
            });
            if (summary) {
              dailySummaryPath = writeDailyFile(memoryConfig.memoryDir, targetDate, summary);
              acceptedOutputChars.set("daily-summary", summary.length);
              state.steps[step.name] = { status: "ok", essential, duration: Math.round((Date.now() - start) / 100) / 10, path: dailySummaryPath };
              writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${step.name}.md`), redactSecrets(summary), "utf-8");
            } else {
              state.steps[step.name] = { status: "skipped", essential };
            }
          } catch (err) {
            if (isSleepModelFailure(err)) {
              logWarn(TAG, `[SLEEP] ${step.name} — terminal model failure (${err.reason}), stopping sleep (not advancing to next phase)`);
              recordTerminalFailure(step.name, err.reason, Date.now() - start);
              break;
            }
            logWarn(TAG, `[SLEEP] daily-summary failed: ${err instanceof Error ? err.message : String(err)}`);
            state.steps[step.name] = { status: "failed", essential, duration: Math.round((Date.now() - start) / 100) / 10 };
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
            const priorPath = state.steps["daily-summary"]?.path;
            if (priorPath && existsSync(priorPath)) {
              dailySummaryPath = priorPath;
              logInfo(TAG, `[SLEEP] ${step.name} — recovered daily path from lock (${priorPath})`);
            }
          }
          if (!dailySummaryPath) {
            state.steps[step.name] = { status: "skipped", essential };
            writeStateFile(statePath, state);
            logInfo(TAG, `[SLEEP] ⏭ ${step.name} — no daily summary`);
            emitSleepEvent(options.onEvent, { type: "step_skipped", runId, step: toSummary(step.name, "skipped", essential, state.steps[step.name]) });
            continue;
          }
          try {
            const userId = sleepData.getPrimaryUserId();
            const result = await extractFromDaily(dailySummaryPath, userId, (p) => sendToRuntime(runtime, p, "extract-memories", runId, signal, stepDeadlineAt, budget, domainRetryDelayMs, now).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }));
            acceptedOutputChars.set("extract-memories", result.trim().length);
            state.steps[step.name] = { status: "ok", essential, duration: Math.round((Date.now() - start) / 100) / 10 };
            writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${step.name}.md`), redactSecrets(result), "utf-8");
            logInfo(TAG, `[SLEEP] ✓ ${step.name} (${((Date.now() - start) / 1000).toFixed(1)}s) — ${result.slice(0, 80)}`);
          } catch (err) {
            if (isSleepModelFailure(err)) {
              logWarn(TAG, `[SLEEP] ${step.name} — terminal model failure (${err.reason}), stopping sleep (not advancing to next phase)`);
              recordTerminalFailure(step.name, err.reason, Date.now() - start);
              break;
            }
            logWarn(TAG, `[SLEEP] extract-memories failed: ${err instanceof Error ? err.message : String(err)}`);
            state.steps[step.name] = { status: "failed", essential, duration: Math.round((Date.now() - start) / 100) / 10 };
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
            const memDb = getMemoryDb(memory);
            const newRows = (memDb?.prepare(
              `SELECT id, content_en, memory_type, topic, trust, semantic_revision FROM extracted_memories WHERE created_at >= ? AND memory_type != 'observation' ORDER BY created_at DESC LIMIT 30`,
            ).all(todayStart.getTime()) ?? []) as Array<{ id: number; content_en: string; memory_type: string; topic: string | null; trust: number; semantic_revision: number }>;
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
                const matches = memDb!.prepare(
                  `SELECT em.id, em.content_en, em.memory_type, em.trust, em.credibility, em.semantic_revision FROM extracted_memories em JOIN extracted_memories_fts fts ON em.id = fts.rowid WHERE extracted_memories_fts MATCH ? AND em.id != ? AND em.trust >= ? AND em.memory_type != 'observation' AND em.valid_to IS NULL LIMIT 5`,
                ).all(keywords, nr.id, nr.trust) as Array<{ id: number; content_en: string; memory_type: string; trust: number; credibility: number; semantic_revision: number }>;
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
              const placeholders = newIds.map(() => "?").join(",");
              const currentRows = memDb!.prepare(
                `SELECT id FROM extracted_memories WHERE user_id = ? AND created_at >= ? AND created_at <= ? AND memory_type != 'observation' AND id IN (${placeholders})`,
              ).all(primaryUserId, state.startedAt, step05PreparedAt, ...newIds) as Array<{ id: number }>;
              for (const cr of currentRows) currentRunNewIds.add(cr.id);
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
            const memDb = getMemoryDb(memory);
            const sample = memDb?.prepare(
              `SELECT id, content_en, memory_type, created_at FROM extracted_memories WHERE trust >= 2 AND memory_type != 'observation' AND valid_to IS NULL ORDER BY RANDOM() LIMIT 10`,
            ).all() as Array<{ id: number; content_en: string; memory_type: string; created_at: number }> ?? [];
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

        const prompt = substituteVars(step.rawPrompt, vars);
        const fullPrompt = soulPrefix + prompt;
        if (soulPrefix) soulPrefix = "";
        let response: string | null;
        try {
          response = await sendToRuntime(runtime, fullPrompt, step.name, runId, signal, stepDeadlineAt, budget, domainRetryDelayMs, now);
        } catch (err) {
          if (isSleepModelFailure(err)) {
            logWarn(TAG, `[SLEEP] ${step.name} — terminal model failure (${err.reason}), stopping sleep (not advancing to next phase)`);
            recordTerminalFailure(step.name, err.reason, Date.now() - start);
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
          if (step.name === "retrospective") vars.RETRO_CONTENT = response;

          if (step.name === "contradiction-and-graph") {
            const memDb = getMemoryDb(memory);
            if (memDb) {
              const contradictRe = /CONTRADICT\s+old_id=(\d+)/g;
              let cm: RegExpExecArray | null;
              while ((cm = contradictRe.exec(response)) !== null) {
                const oldId = parseInt(cm[1]!, 10);
                const old = memDb.prepare("SELECT user_id, semantic_revision FROM extracted_memories WHERE id = ? AND valid_to IS NULL AND classification < 3").get(oldId) as { user_id: string; semantic_revision: number } | undefined;
                if (old) {
                  const result = sleepData.invalidateMemory(old.user_id, oldId, old.semantic_revision, localDate(new Date()), "sleep:contradiction");
                  if (result.ok) logInfo(TAG, `[SLEEP] Invalidated memory #${oldId} (contradicted)`);
                }
              }
              const relationRe = /RELATION\s+entity_a="([^"]+)"\s+entity_b="([^"]+)"\s+rel="([^"]+)"/g;
              let rm: RegExpExecArray | null;
              while ((rm = relationRe.exec(response)) !== null) {
                const [, a, b, rel] = rm;
                memDb.prepare(
                  `INSERT INTO entity_graph (entity_a, entity_b, relation, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(entity_a, entity_b, relation) DO UPDATE SET last_seen_at = ?`
                ).run(a, b, rel, Date.now(), Date.now(), Date.now());
              }
              const EVENT_MIN_AGE_DAYS = 7;
              const DECAY_THRESHOLD = 0.1;
              const nowMs = Date.now();
              const decayCandidates = memDb.prepare(
                `SELECT id, recall_count, created_at FROM extracted_memories WHERE memory_type = 'event' AND valid_to IS NULL AND created_at < ?`
              ).all(nowMs - EVENT_MIN_AGE_DAYS * 86400_000) as { id: number; recall_count: number; created_at: number }[];
              let agedCount = 0;
              for (const m of decayCandidates) {
                const ageDays = (nowMs - m.created_at) / 86400_000;
                const score = m.recall_count / ageDays;
                if (score < DECAY_THRESHOLD) {
                  const aged = memDb.prepare("SELECT user_id, semantic_revision FROM extracted_memories WHERE id = ? AND valid_to IS NULL").get(m.id) as { user_id: string; semantic_revision: number } | undefined;
                  if (aged) {
                    const result = sleepData.invalidateMemory(aged.user_id, m.id, aged.semantic_revision, localDate(new Date(nowMs)), "sleep:decay");
                    if (result.ok) agedCount++;
                  }
                }
              }
              if (agedCount > 0) logInfo(TAG, `[SLEEP] Aged out ${agedCount} faded event memories (score < ${DECAY_THRESHOLD})`);
            }
          }
        } else {
          // null: budget exhausted or caller aborted mid-call (invalid-response
          // exhaustion now raises the typed terminal error instead).
          state.steps[step.name] = { status: "failed", essential, duration: Math.round(duration / 100) / 10 };
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
      const dailyArtifactUsable =
        dailySummaryStep?.status === "ok" && typeof dailySummaryStep.path === "string" && dailySummaryStep.path.length > 0
          ? readDailyArtifact(dailySummaryStep.path).usable
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
        steps.map(s => s.name),
      );

      let applied = false;
      for (const f of findings) {
        if (!f.downgrade) continue;
        const s = state.steps[f.stepId];
        if (s?.status === "ok") {
          s.status = "failed";
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
      const step05Ok = state.steps["contradiction-and-graph"]?.status === "ok";
      const retained = vars.CONTRADICTION_AND_GRAPH_OUTPUT;
      if (step05Ok && typeof retained === "string" && retained.length > 0) {
        const memDb = getMemoryDb(memory);
        if (memDb) {
          const questionStore = new DreamQuestionStore(memDb, { now });
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
      writeAuditLog(memoryConfig.memoryDir, {
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
        const garbagePath = join(memoryConfig.memoryDir, "garbage.json");
        if (existsSync(garbagePath)) {
          const raw = JSON.parse(readFileSync(garbagePath, "utf-8"));
          const garbage: Array<{ msg_id?: number }> = Array.isArray(raw) ? raw : (Array.isArray(raw?.messages) ? raw.messages : []);
          if (garbage.length > 0) {
            const ids = garbage.map(g => g.msg_id).filter((id): id is number => typeof id === "number");
            if (ids.length > 0) {
              sleepData.deleteMessagesByIds(ids);
              logInfo(TAG, `[SLEEP] Flushed ${ids.length} garbage messages`);
            }
            writeFileSync(garbagePath, "[]");
          }
        }
        const { agedOut, capped } = sleepData.flushOldMessages({ maxAgeDays: 7, maxCount: 500 });
        if (agedOut > 0) logInfo(TAG, `[SLEEP] Flushed ${agedOut} messages >7d`);
        if (capped > 0) logInfo(TAG, `[SLEEP] Flushed ${capped} messages (cap 500)`);
      } catch (err) { logWarn(TAG, `[WIRED] flush failed: ${err instanceof Error ? err.message : String(err)}`); }
    }

    logInfo(TAG, `[SLEEP] 🏁 ${okCount} ok, ${failCount} failed, ${skipCount} skipped | wired: ${formatWiredResults(wiredResults)} | ${totalDuration.toFixed(0)}s total`);

    if (failCount === 0) {
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
    const result = projectResult(runId, terminalStatus, startedAt, now(), state, watermarkAdvanced, resumable, terminalModelFailure, reviewLine);
    emitSleepEvent(options.onEvent, { type: "cycle_finished", runId, result });
    return result;
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

function toSummary(id: string, status: SleepStepSummary["status"], essential: boolean, s: StepResult | undefined): SleepStepSummary {
  return {
    id,
    status,
    essential,
    attempts: s?.attempts ?? 1,
    durationMs: s?.duration != null ? Math.round(s.duration * 1000) : undefined,
  };
}

// ── #1515: step-05 clarification-candidate gate ─────────────────────────────
// Runs after #1653 downgrades, before terminal settlement. Pure deterministic
// validation over the retained step-05 response plus the exact evidence
// snapshots captured when the prompt was prepared. Only fully authorized
// candidates reach the question store (which enforces dedupe/caps under race).
// Exported for direct-input tests only — not part of the public contract.

export interface AskCandidateContext {
  /** Retained step-05 response (vars.CONTRADICTION_AND_GRAPH_OUTPUT). */
  response: string;
  questionStore: DreamQuestionStore;
  memDb: Database.Database;
  userId: string;
  runId: string;
  newEvidenceRevisions: ReadonlyMap<number, number>;
  existingEvidenceRevisions: ReadonlyMap<number, number>;
  currentRunNewIds: ReadonlySet<number>;
}

export interface ParsedAskCandidate {
  oldId: number;
  newId: number;
  question: string;
}

export const ASK_MAX_CANDIDATES_PER_RUN = 3;
export const ASK_QUESTION_MIN_CHARS = 20;
export const ASK_QUESTION_MAX_CHARS = 300;

const ASK_LINE_RE = /^ASK\s+old_id=(\d+)\s+new_id=(\d+)\s+question=(.+)$/;

/** Parse only exact anchored ASK lines in response order. Commentary and
 *  malformed lines are ignored; no template fallback ever invents a question. */
export function parseAskLines(response: string): ParsedAskCandidate[] {
  const candidates: ParsedAskCandidate[] = [];
  for (const rawLine of response.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("ASK")) continue;
    const m = ASK_LINE_RE.exec(line);
    if (!m) continue;
    const oldId = parseInt(m[1]!, 10);
    const newId = parseInt(m[2]!, 10);
    let question: unknown;
    try {
      question = JSON.parse(m[3]!);
    } catch {
      continue;
    }
    if (typeof question !== "string" || question.length === 0) continue;
    candidates.push({ oldId, newId, question });
  }
  return candidates;
}

/** Normalize to one trimmed line with repeated whitespace collapsed, then
 *  enforce the 20-300 char window and a literal `?`. Returns null when the
 *  candidate does not meet the deterministic shape. */
export function normalizeQuestion(raw: string): string | null {
  const oneLine = raw.replace(/\r\n/g, "\n").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  if (oneLine.length < ASK_QUESTION_MIN_CHARS || oneLine.length > ASK_QUESTION_MAX_CHARS) return null;
  if (!oneLine.includes("?")) return null;
  return oneLine;
}

/**
 * Evaluate the retained step-05 ASK lines in response order against the
 * deterministic gate and the current database truth, persisting at most three
 * accepted candidates per run. Returns the number of accepted rows.
 *
 * Role is validated BEFORE canonicalization: old_id must be an existing
 * evidence id and new_id a current-run new id. After authorization the pair is
 * canonicalized (memory_a_id = min, memory_b_id = max) and each revision is
 * mapped to its canonical id.
 */
export function processAskCandidates(ctx: AskCandidateContext): number {
  const candidates = parseAskLines(ctx.response);
  let accepted = 0;
  for (const candidate of candidates) {
    if (accepted >= ASK_MAX_CANDIDATES_PER_RUN) break;
    const { oldId, newId } = candidate;

    if (!Number.isSafeInteger(oldId) || !Number.isSafeInteger(newId)) continue;
    if (oldId < 1 || newId < 1 || oldId === newId) continue;
    const expectedNewRevision = ctx.newEvidenceRevisions.get(newId);
    const expectedOldRevision = ctx.existingEvidenceRevisions.get(oldId);
    if (expectedNewRevision === undefined || expectedOldRevision === undefined) continue;
    if (!ctx.currentRunNewIds.has(newId)) continue;

    const question = normalizeQuestion(candidate.question);
    if (question === null) continue;
    if (redactSecrets(question) !== question) continue;

    // One bounded statement over both current evidence rows.
    const rows = ctx.memDb.prepare(
      `SELECT id, user_id, valid_to, classification, semantic_revision
       FROM extracted_memories WHERE id IN (?, ?)`,
    ).all(oldId, newId) as Array<{
      id: number; user_id: string; valid_to: string | null; classification: number; semantic_revision: number;
    }>;
    const byId = new Map(rows.map(r => [r.id, r]));
    const oldRow = byId.get(oldId);
    const newRow = byId.get(newId);
    if (!oldRow || !newRow) continue;
    const rowOk = (r: { user_id: string; valid_to: string | null; classification: number; semantic_revision: number }, expectedRevision: number): boolean =>
      r.user_id === ctx.userId && r.valid_to === null && r.classification < 3 && r.semantic_revision === expectedRevision;
    if (!rowOk(oldRow, expectedOldRevision) || !rowOk(newRow, expectedNewRevision)) continue;

    // Canonicalize pair and map each revision to the canonical id.
    const memoryAId = Math.min(oldId, newId);
    const memoryBId = Math.max(oldId, newId);
    const revisionFor = (id: number): number | undefined => {
      const old = ctx.existingEvidenceRevisions.get(id);
      return old !== undefined ? old : ctx.newEvidenceRevisions.get(id);
    };
    const memoryARevision = revisionFor(memoryAId);
    const memoryBRevision = revisionFor(memoryBId);
    if (memoryARevision === undefined || memoryBRevision === undefined) continue;

    const result = ctx.questionStore.insertCandidate({
      userId: ctx.userId,
      memoryAId,
      memoryBId,
      memoryARevision,
      memoryBRevision,
      question,
      sourceRunId: ctx.runId,
    });
    if (result.accepted) accepted++;
  }
  return accepted;
}

// ── #1653: deterministic pre-settlement review ──────────────────────────────
// A pure, bounded judgment over the truthful step results and artifacts that
// exist AFTER the step loop and BEFORE lock settlement, watermark advancement,
// garbage deletion, and old-message flushing. It never calls a model and
// consumes no budget. Only `ok` steps may be downgraded to `failed`; all other
// StepResult fields are preserved.

export type ReviewFindingCode =
  | "step_failed"
  | "daily_artifact_unusable"
  | "no_extraction_writes"
  | "budget_without_output";

export interface ReviewFinding {
  stepId: string;
  code: ReviewFindingCode;
  /** Stable, bounded, deterministic human-readable text — no response content,
   *  prompt text, path, memory content, or secret. */
  detail: string;
  /** Whether this finding invalidates an `ok` step and rewrites it to failed. */
  downgrade: boolean;
  /** Whether the run must be left resumable for an explicit `/sleep resume`. */
  repeat: boolean;
}

/** Explicit inputs to the review — the only way the review learns facts. */
export interface SleepReviewFacts {
  bufferedMessageCount: number;
  /** Non-observation extraction count in the run window; null when the query
   *  was not relevant and therefore not executed. */
  extractedMemoryCount: number | null;
  stepCalls: (stepId: string) => number;
  /** Accepted domain output length per step; absent = no recorded output. */
  acceptedOutputChars: ReadonlyMap<string, number>;
  /** null when daily-summary is not `ok` or recorded no path (no artifact fact). */
  dailyArtifactUsable: boolean | null;
}

/**
 * Deterministic review over persisted step statuses plus run-local facts.
 * Existing failed/timeout has precedence; at most one finding per step, in
 * loaded step order. Exported for direct deterministic-input tests only — not
 * part of the public contract surface (see SUPPORTED-SURFACE.md).
 */
export function evaluateSleepReview(
  state: SleepState,
  facts: SleepReviewFacts,
  stepOrder: readonly string[],
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const seen = new Set<string>();
  const order = [...stepOrder, ...Object.keys(state.steps).filter(k => !stepOrder.includes(k))];

  for (const stepId of order) {
    if (seen.has(stepId)) continue;
    seen.add(stepId);
    const s = state.steps[stepId];
    if (!s) continue;

    if (s.status === "failed" || s.status === "timeout") {
      findings.push({
        stepId,
        code: "step_failed",
        detail: "step did not complete",
        downgrade: false,
        repeat: true,
      });
      continue;
    }
    if (s.status !== "ok") continue; // skipped/pending: no derived rule applies

    const calls = facts.stepCalls(stepId);
    const outputChars = facts.acceptedOutputChars.get(stepId) ?? 0;

    if (stepId === "daily-summary" && facts.dailyArtifactUsable === false) {
      findings.push({
        stepId,
        code: "daily_artifact_unusable",
        detail: "daily artifact missing or unusable",
        downgrade: true,
        repeat: true,
      });
      continue;
    }

    if (
      stepId === "extract-memories"
      && facts.bufferedMessageCount > 0
      && calls > 0
      && facts.extractedMemoryCount === 0
    ) {
      findings.push({
        stepId,
        code: "no_extraction_writes",
        detail: "no extraction writes",
        downgrade: true,
        repeat: true,
      });
      continue;
    }

    if (calls > 0 && outputChars === 0) {
      findings.push({
        stepId,
        code: "budget_without_output",
        detail: "budget consumed without output",
        downgrade: true,
        repeat: true,
      });
    }
  }

  return findings;
}

/** Bounded count of the primary user's non-observation memories created in the
 *  run window. Count only — content never leaves the query (#1653). */
function countNonObservationExtractions(memory: MemoryManager, userId: string, fromMs: number, toMs: number): number {
  try {
    const memDb = getMemoryDb(memory);
    if (!memDb) return 0;
    const row = memDb.prepare(
      `SELECT COUNT(*) AS count FROM extracted_memories WHERE user_id = ? AND created_at >= ? AND created_at <= ? AND memory_type != 'observation'`,
    ).get(userId, fromMs, toMs) as { count: number } | undefined;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

function projectResult(
  runId: string,
  status: SleepTerminalStatus,
  startedAt: number,
  finishedAt: number,
  state: SleepState,
  watermarkAdvanced: boolean,
  resumable: boolean,
  terminalFailure?: { stepId: string; reason: SleepModelFailureReason } | null,
  reviewLine?: string | null,
): SleepRunResult {
  const steps: SleepStepSummary[] = Object.entries(state.steps).map(([id, s]) =>
    toSummary(id, s.status === "ok" ? "completed" : s.status === "timeout" ? "timeout" : s.status === "skipped" ? "skipped" : "failed", s.essential ?? ESSENTIAL_STEPS.has(id), s));
  const essentialFailures = failedEssentials(state);
  const okCount = steps.filter(s => s.status === "completed").length;
  const failCount = steps.filter(s => s.status === "failed" || s.status === "timeout").length;
  const skipCount = steps.filter(s => s.status === "skipped").length;
  // #1611: a terminal model failure yields a bounded, actionable report that
  // names the failed step and stable reason and confirms no fallback ran.
  // #1653: a review downgrade line is appended only when it adds a distinct
  // fact — a pure step_failed finding duplicates the status sentence.
  const report = terminalFailure
    ? `Sleep failed at ${terminalFailure.stepId} (${terminalFailure.reason}); no fallback was attempted.\nFix the Dreamy model/provider configuration, then resume sleep.`
        + (reviewLine ? `\n${reviewLine}` : "")
    : `Sleep ${status} — ${okCount} completed, ${failCount} failed, ${skipCount} skipped (of ${steps.length}).`
      + (essentialFailures.length > 0 ? ` Essential failures: ${essentialFailures.join(", ")}.` : "")
      + (reviewLine ? ` ${reviewLine}` : "");
  return {
    runId,
    status,
    startedAt,
    finishedAt,
    llmCalls: state.llmCalls ?? 0,
    steps,
    essentialFailures,
    resumable,
    watermarkAdvanced,
    report,
  };
}

function alreadyRunningResult(startedAt: number, finishedAt: number): SleepRunResult {
  return {
    runId: "",
    status: "already_running",
    startedAt,
    finishedAt,
    llmCalls: 0,
    steps: [],
    essentialFailures: [],
    resumable: false,
    watermarkAdvanced: false,
    report: "Sleep cycle already running — no-op.",
  };
}

function noWorkResult(runId: string, startedAt: number, finishedAt: number): SleepRunResult {
  return {
    runId,
    status: "no_work",
    startedAt,
    finishedAt,
    llmCalls: 0,
    steps: [],
    essentialFailures: [],
    resumable: false,
    watermarkAdvanced: false,
    report: "No messages since last sleep — nothing to process.",
  };
}

// CLI entry + isDirectRun removed — the standalone entry point lives in
// cli/abmind-sleep.ts. Library consumers call runSleepCycle(options) directly
// with their own SleepRuntime.
