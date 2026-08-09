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
import { MemoryManager, getMemoryDb } from "../memory-manager.js";
import { loadMemoryConfig } from "../memory-config.js";
import { SleepStateGatherer } from "../sleep-state-gatherer.js";
import { SleepDataAccess } from "../sleep-data-access.js";
import { loadSleepSteps, buildSleepVars, substituteVars } from "../sleep-pipeline.js";
import { buildDailySummary, writeDailyFile, LLMUnavailableError } from "../sleep-pipeline.js";
import { extractFromDaily } from "../sleep-pipeline.js";
import { logInfo, logWarn, logError } from "../mem-logger.js";
import { localDate } from "../local-time.js";
import type { SleepStep } from "../sleep-pipeline.js";
import { type Level, parseLevel, DEFAULT_LEVEL } from "./levels.js";
import { readStateFile, writeStateFile, runWiredPreTasks, formatWiredResults } from "./state.js";
import type { SleepState, StepResult, WiredResults } from "./state.js";
import { buildSnapshotSummary, writeAuditLog } from "./audit.js";
import { toDateStr, toIsoDate, dateStrToMs, scanPreviousLocks } from "./locks.js";
import { redactSecrets } from "../redact-secrets.js";
import { TransportUnavailableError, LlmBudget, sendToRuntime, MAX_DOMAIN_RETRIES } from "./llm-budget.js";
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
    // supplied; otherwise initialize it from the saved users.json master user.
    // Never guess from DB row order — fail clearly when nothing is configured.
    const primaryUserId = ensurePrimaryUserId();
    if (!primaryUserId) {
      throw new Error(
        "Primary user identity is not configured: ABMIND_USER_ID is not set and no master user is saved in config/users.json. " +
          "Set ABMIND_USER_ID, or add a master user to config/users.json, before running sleep.",
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
        .map(m => `[${m.role}]${m.emotion_score ? ` (emotion:${m.emotion_score})` : ""} ${m.content.slice(0, 500)}`);

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

    try {
      if (isResume) {
        const completedCount = Object.values(state.steps).filter(s => s.status === "ok").length;
        state.llmCalls = completedCount;
      }
      const budget = new LlmBudget(state, statePath);

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

            const summary = await buildDailySummary(sleepData.getDb(), (p) => sendToRuntime(runtime, p, "daily-summary", runId, signal, budget, domainRetryDelayMs).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }), {
              ctxWindow, memoryDir: memoryConfig.memoryDir, userId, watermarkTs,
            });
            if (summary) {
              dailySummaryPath = writeDailyFile(memoryConfig.memoryDir, targetDate, summary);
              state.steps[step.name] = { status: "ok", essential, duration: Math.round((Date.now() - start) / 100) / 10, path: dailySummaryPath };
              writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${step.name}.md`), redactSecrets(summary), "utf-8");
            } else {
              state.steps[step.name] = { status: "skipped", essential };
            }
          } catch (err) {
            logWarn(TAG, `[SLEEP] daily-summary failed: ${err instanceof Error ? err.message : String(err)}`);
            state.steps[step.name] = { status: "failed", essential, duration: Math.round((Date.now() - start) / 100) / 10 };
            writeStateFile(statePath, state);
            emitSleepEvent(options.onEvent, { type: "step_failed", runId, step: toSummary(step.name, "failed", essential, state.steps[step.name]) });
            if (err instanceof TransportUnavailableError) {
              logWarn(TAG, `[SLEEP] ${step.name} — runtime rejected, stopping cycle (not advancing to next phase)`);
              break;
            }
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
            const result = await extractFromDaily(dailySummaryPath, userId, (p) => sendToRuntime(runtime, p, "extract-memories", runId, signal, budget, domainRetryDelayMs).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }));
            state.steps[step.name] = { status: "ok", essential, duration: Math.round((Date.now() - start) / 100) / 10 };
            writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${step.name}.md`), redactSecrets(result), "utf-8");
            logInfo(TAG, `[SLEEP] ✓ ${step.name} (${((Date.now() - start) / 1000).toFixed(1)}s) — ${result.slice(0, 80)}`);
          } catch (err) {
            logWarn(TAG, `[SLEEP] extract-memories failed: ${err instanceof Error ? err.message : String(err)}`);
            state.steps[step.name] = { status: "failed", essential, duration: Math.round((Date.now() - start) / 100) / 10 };
            writeStateFile(statePath, state);
            emitSleepEvent(options.onEvent, { type: "step_failed", runId, step: toSummary(step.name, "failed", essential, state.steps[step.name]) });
            if (err instanceof TransportUnavailableError) {
              logWarn(TAG, `[SLEEP] ${step.name} — runtime rejected, stopping cycle (not advancing to next phase)`);
              break;
            }
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
              `SELECT id, content_en, memory_type, topic, trust FROM extracted_memories WHERE created_at >= ? AND memory_type != 'observation' ORDER BY created_at DESC LIMIT 30`,
            ).all(todayStart.getTime()) ?? []) as Array<{ id: number; content_en: string; memory_type: string; topic: string | null; trust: number }>;
            if (newRows.length === 0) {
              state.steps[step.name] = { status: "skipped", essential };
              writeStateFile(statePath, state);
              logInfo(TAG, `[SLEEP] ⏭ ${step.name} — no new extractions today`);
              emitSleepEvent(options.onEvent, { type: "step_skipped", runId, step: toSummary(step.name, "skipped", essential, state.steps[step.name]) });
              continue;
            }
            vars.NEW_EXTRACTIONS = newRows.map(r => `[id=${r.id}] (${r.memory_type}, trust=${r.trust}) ${r.content_en}`).join("\n");
            const candidateIds = new Set<number>();
            const candidateRows: Array<{ id: number; content_en: string; memory_type: string; trust: number; credibility: number }> = [];
            for (const nr of newRows.slice(0, 5)) {
              const keywords = nr.content_en.split(/\s+/).filter(w => w.length > 3).slice(0, 3).join(" OR ");
              if (!keywords) continue;
              try {
                const matches = memDb!.prepare(
                  `SELECT em.id, em.content_en, em.memory_type, em.trust, em.credibility FROM extracted_memories em JOIN extracted_memories_fts fts ON em.id = fts.rowid WHERE extracted_memories_fts MATCH ? AND em.id != ? AND em.trust >= ? AND em.memory_type != 'observation' AND em.valid_to IS NULL LIMIT 5`,
                ).all(keywords, nr.id, nr.trust) as Array<{ id: number; content_en: string; memory_type: string; trust: number; credibility: number }>;
                for (const m of matches) {
                  if (!candidateIds.has(m.id) && candidateIds.size < 20) {
                    candidateIds.add(m.id);
                    candidateRows.push(m);
                  }
                }
              } catch { /* FTS query might fail on special chars — skip */ }
            }
            vars.CONTRADICTION_CANDIDATES = candidateRows.length > 0
              ? candidateRows.map(r => `[id=${r.id}] (${r.memory_type}, trust=${r.trust}, cred=${r.credibility}) ${r.content_en}`).join("\n")
              : "No existing memories with overlapping content found.";
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
          response = await sendToRuntime(runtime, fullPrompt, step.name, runId, signal, budget, domainRetryDelayMs);
        } catch (err) {
          if (err instanceof TransportUnavailableError) {
            const duration = Date.now() - start;
            logWarn(TAG, `[SLEEP] ${step.name} — runtime rejected, stopping cycle (not advancing to next phase)`);
            state.steps[step.name] = { status: "failed", essential, duration: Math.round(duration / 100) / 10 };
            writeStateFile(statePath, state);
            emitSleepEvent(options.onEvent, { type: "step_failed", runId, step: toSummary(step.name, "failed", essential, state.steps[step.name]) });
            break;
          }
          throw err;
        }
        const duration = Date.now() - start;

        // Checkpoint boundary: after the awaited call, before applying its output.
        if (signal.aborted) { persistCancelled(); break; }

        if (response) {
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
          state.steps[step.name] = { status: "failed", essential, duration: Math.round(duration / 100) / 10, attempts: MAX_DOMAIN_RETRIES };
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

    // #1603: the gate for the lock status, the watermark, and the garbage
    // flush is "no essential step failed" — a non-essential step's failure
    // must not freeze the memory pipeline.
    const essentialsOk = failedEssentials(state).length === 0;

    // Set final status
    if (state.status === "ongoing") {
      state.status = essentialsOk ? "completed" : "failed";
      writeStateFile(statePath, state);
    }

    // Checkpoint boundary: before watermark advance.
    let watermarkAdvanced = false;
    if (essentialsOk && !signal.aborted) {
      try {
        const count = sleepData.advanceExtractionWatermarks(watermarkTargetTs);
        watermarkAdvanced = count > 0;
        logInfo(TAG, `[SLEEP] Extraction watermark advanced for ${count} chat(s)`);
      } catch { /* non-fatal */ }
    } else if (!essentialsOk) {
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

    if (essentialsOk) {
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
      failCount === 0 ? "completed"
      : failedEssentials(state).length > 0 ? "failed"
      : "partial";
    const result = projectResult(runId, terminalStatus, startedAt, now(), state, watermarkAdvanced, failedEssentials(state).length > 0);
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

function projectResult(
  runId: string,
  status: SleepTerminalStatus,
  startedAt: number,
  finishedAt: number,
  state: SleepState,
  watermarkAdvanced: boolean,
  resumable: boolean,
): SleepRunResult {
  const steps: SleepStepSummary[] = Object.entries(state.steps).map(([id, s]) =>
    toSummary(id, s.status === "ok" ? "completed" : s.status === "timeout" ? "timeout" : s.status === "skipped" ? "skipped" : "failed", s.essential ?? ESSENTIAL_STEPS.has(id), s));
  const essentialFailures = failedEssentials(state);
  const okCount = steps.filter(s => s.status === "completed").length;
  const failCount = steps.filter(s => s.status === "failed" || s.status === "timeout").length;
  const skipCount = steps.filter(s => s.status === "skipped").length;
  const report = `Sleep ${status} — ${okCount} completed, ${failCount} failed, ${skipCount} skipped (of ${steps.length}).`
    + (essentialFailures.length > 0 ? ` Essential failures: ${essentialFailures.join(", ")}.` : "");
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
