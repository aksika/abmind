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
import { logInfo, logWarn, logError, logTrace } from "../mem-logger.js";
import { localDate } from "../local-time.js";
import type { SleepStep } from "../sleep-pipeline.js";
import { type Level, parseLevel, DEFAULT_LEVEL } from "./levels.js";
import { readStateFile, writeStateFile, runWiredPreTasks, formatWiredResults, isResumableSleepState } from "./state.js";
import type { SleepState, StepResult, WiredResults } from "./state.js";
import { buildSnapshotSummary, writeAuditLog } from "./audit.js";
import { toDateStr, toIsoDate, dateStrToMs, scanPreviousLocks } from "./locks.js";
import { redactSecrets } from "../redact-secrets.js";
import { TransportUnavailableError, LlmBudget, sendToRuntime, MAX_DOMAIN_RETRIES, DEFAULT_RETRY_DELAYS, isSleepModelFailure, SleepModelFailureError } from "./llm-budget.js";
import type { SleepModelFailureReason } from "./llm-budget.js";
import { sleepStepDeadlineMs } from "./step-deadlines.js";
import { ensurePrimaryUserId } from "../user-utils.js";
import { CATCHUP_MAX_AGE_DAYS, failedEssentials, runCatchUp } from "./catchup.js";
import { emitSleepEvent } from "./contracts.js";
import { isSleepStepEligible, sleepStepConfig, type SleepEligibilityContext } from "./sleep-manifest.js";
import type {
  SleepRunOptions,
  SleepRunResult,
  SleepStepSummary,
  SleepTerminalStatus,
  SleepFailure,
  SleepFailureCause,
} from "./contracts.js";

const TAG = "abmind-sleep";

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

const SLEEP_FAILURE_CAUSES: ReadonlySet<string> = new Set([
  "provider_failed","provider_timeout","step_deadline","invalid_response",
  "prompt_round_limit","candidate_round_limit","candidate_exhausted","policy_rejected",
  "nonzero_exit","spawn_error","timeout","aborted","shell_syntax_error","repeated_failure",
  "memory_validation","memory_not_found","memory_conflict","memory_unauthorized",
  "memory_idempotency_conflict","memory_unavailable","memory_outcome_unknown",
  "completion_settlement_failed","service_failed","unknown"
]);

function toBoundedFailure(cause: string, detail?: string, fingerprint?: string): SleepFailure {
  const normalized = SLEEP_FAILURE_CAUSES.has(cause) ? cause as SleepFailureCause : "unknown";
  const bounded: SleepFailure = { cause: normalized };
  if (detail) {
    const redacted = redactSecrets(String(detail)).slice(0, 240);
    if (redacted) bounded.detail = redacted;
  }
  if (fingerprint && /^[0-9a-f]{16}$/i.test(fingerprint)) bounded.commandFingerprint = fingerprint;
  return bounded;
}

function failureFromError(err: unknown, fallbackCause: SleepFailureCause = "unknown"): SleepFailure {
  if (err && typeof err === "object" && "failure" in (err as Record<string, unknown>)) {
    const f = (err as { failure?: SleepFailure }).failure;
    if (f?.cause) return toBoundedFailure(f.cause, f.detail, f.commandFingerprint);
  }
  if (isSleepModelFailure(err)) {
    const f = (err as { failure?: SleepFailure }).failure;
    if (f?.cause) return toBoundedFailure(f.cause, f.detail ?? err.message, f.commandFingerprint);
    // Map broad reason to cause when no specific failure present
    const map: Record<string, SleepFailureCause> = {
      provider_failed: "provider_failed",
      provider_timeout: "provider_timeout",
      step_deadline: "step_deadline",
      invalid_response: "invalid_response",
    };
    const cause = map[err.reason] ?? fallbackCause;
    return toBoundedFailure(cause, err.message);
  }
  const msg = err instanceof Error ? err.message : String(err);
  // Heuristic for policy/tool failures wrapped as generic errors
  if (/policy_rejected/i.test(msg)) return toBoundedFailure("policy_rejected", msg);
  if (/shell_syntax_error/i.test(msg)) return toBoundedFailure("shell_syntax_error", msg);
  if (/timeout/i.test(msg)) return toBoundedFailure("timeout", msg);
  return toBoundedFailure(fallbackCause, msg);
}

function actionForCause(cause: SleepFailureCause): string {
  switch (cause) {
    case "prompt_round_limit":
    case "candidate_round_limit":
    case "candidate_exhausted":
      return "Review the provider/model or loop; keep the safety limit unchanged, then retry.";
    case "policy_rejected":
      return "Review the sleep command policy; sleep does not wait for Telegram authorization.";
    case "nonzero_exit":
    case "spawn_error":
    case "timeout":
    case "aborted":
    case "shell_syntax_error":
    case "repeated_failure":
      return "Review the named tool failure and command fingerprint, then retry.";
    case "provider_timeout":
    case "provider_failed":
      return "Check provider/transport availability, then retry.";
    case "step_deadline":
      return "Retry after checking provider latency or step deadline configuration.";
    case "invalid_response":
      return "Check the configured model's response format, then retry.";
    case "memory_validation":
    case "memory_not_found":
    case "memory_conflict":
    case "memory_unauthorized":
    case "memory_idempotency_conflict":
    case "memory_unavailable":
    case "memory_outcome_unknown":
      return "Check the memory backend and the named memory error, then retry.";
    case "completion_settlement_failed":
      return "Check the runtime broker/lease state, then retry.";
    case "service_failed":
    case "unknown":
    default:
      return "Check daemon/service availability, then retry.";
  }
}

function detailForCause(cause: SleepFailureCause): string {
  switch (cause) {
    case "prompt_round_limit": return "hard 25 prompt rounds reached";
    case "candidate_round_limit": return "candidate round limit reached";
    case "candidate_exhausted": return "no eligible candidate";
    case "policy_rejected": return "command blocked by policy";
    case "step_deadline": return "logical step deadline exceeded";
    case "invalid_response": return "model returned empty/invalid responses";
    case "provider_timeout": return "provider timed out";
    case "provider_failed": return "provider failed";
    default: return cause;
  }
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
    // #1752 R7: recover daily path from checkpoint for resume before any prompt-driven step
    if (existingState?.steps["daily-summary"]?.status === "ok") {
      const prior = existingState.steps["daily-summary"]?.path;
      if (prior && existsSync(prior)) {
        dailySummaryPath = prior;
        vars.DAILY_PATH = vars.RETRO_PATH = prior;
        logInfo(TAG, `[SLEEP] recovered daily path from lock (${prior})`);
      } else if (prior) {
        logWarn(TAG, `[SLEEP] daily artifact missing (${prior}) — retrospective will be skipped, review will downgrade daily-summary`);
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
            const firstMsgTs = sleepData.getFirstMessageAfter(userId, watermarkTs);
            const firstMsgDate = firstMsgTs ? new Date(firstMsgTs) : new Date(now());
            const targetDate = `${firstMsgDate.getFullYear()}-${String(firstMsgDate.getMonth() + 1).padStart(2, "0")}-${String(firstMsgDate.getDate()).padStart(2, "0")}`;

            const summary = await buildDailySummary(sleepData.getDb(), (p) => sendToRuntime(runtime, p, "daily-summary", runId, signal, stepDeadlineAt, budget, retryDelays, now).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }), {
              ctxWindow, memoryDir: memoryConfig.memoryDir, userId, watermarkTs,
            });
            if (summary) {
              dailySummaryPath = writeDailyFile(memoryConfig.memoryDir, targetDate, summary);
              // #1752 R7: bind actual write path before retrospective substitution; covers non-current dated summaries
              vars.DAILY_PATH = vars.RETRO_PATH = dailySummaryPath;
              acceptedOutputChars.set("daily-summary", summary.length);
              state.steps[step.name] = { status: "ok", essential, duration: Math.round((Date.now() - start) / 100) / 10, path: dailySummaryPath };
              writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${step.name}.md`), redactSecrets(summary), "utf-8");
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
            const priorPath = state.steps["daily-summary"]?.path;
            if (priorPath && existsSync(priorPath)) {
              effectivePath = priorPath;
              dailySummaryPath = priorPath;
              vars.DAILY_PATH = vars.RETRO_PATH = priorPath;
              logInfo(TAG, `[SLEEP] retrospective — recovered daily path from lock (${priorPath})`);
            }
          }
          // Fallback for legacy locks without path field (test preseed) — scan daily dir
          if (!effectivePath && state.steps["daily-summary"]?.status === "ok") {
            try {
              const dailyDir = join(memoryConfig.memoryDir, "daily");
              if (existsSync(dailyDir)) {
                const files = readdirSync(dailyDir).filter(f => f.startsWith("daily_") && f.endsWith(".md")).sort();
                if (files.length > 0) {
                  const latest = files[files.length - 1]!;
                  const found = join(dailyDir, latest);
                  if (existsSync(found) && readDailyArtifact(found).usable) {
                    effectivePath = found;
                    dailySummaryPath = found;
                    vars.DAILY_PATH = vars.RETRO_PATH = found;
                    logInfo(TAG, `[SLEEP] retrospective — recovered daily path via scan (${found})`);
                  }
                }
              }
            } catch {}
          }
          if (!effectivePath) {
            const dailyStatus = state.steps["daily-summary"]?.status ?? "missing";
            logInfo(TAG, `[SLEEP] ⏭ retrospective — no daily summary artifact (daily-summary: ${dailyStatus})`);
            state.steps[step.name] = { status: "skipped", essential };
            writeStateFile(statePath, state);
            emitSleepEvent(options.onEvent, { type: "step_skipped", runId, step: toSummary(step.name, "skipped", essential, state.steps[step.name]) });
            continue;
          }
          if (!existsSync(effectivePath)) {
            logWarn(TAG, `[SLEEP] ⏭ retrospective — daily artifact missing (${effectivePath}) — leaving daily-summary for review`);
            state.steps[step.name] = { status: "skipped", essential };
            writeStateFile(statePath, state);
            emitSleepEvent(options.onEvent, { type: "step_skipped", runId, step: toSummary(step.name, "skipped", essential, state.steps[step.name]) });
            continue;
          }
          const artifact = readDailyArtifact(effectivePath);
          if (!artifact.usable) {
            logWarn(TAG, `[SLEEP] ⏭ retrospective — daily artifact unusable (${effectivePath}) — leaving daily-summary for review`);
            state.steps[step.name] = { status: "skipped", essential };
            writeStateFile(statePath, state);
            emitSleepEvent(options.onEvent, { type: "step_skipped", runId, step: toSummary(step.name, "skipped", essential, state.steps[step.name]) });
            continue;
          }
          vars.DAILY_PATH = vars.RETRO_PATH = effectivePath;
          dailySummaryPath = effectivePath;
        }

        const prompt = substituteVars(step.rawPrompt, vars);
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
              const effectivePath = dailySummaryPath ?? state.steps["daily-summary"]?.path;
              if (effectivePath && existsSync(effectivePath)) {
                const check = readDailyArtifact(effectivePath);
                if (check.usable) {
                  logInfo(TAG, `[SLEEP] retrospective empty response but artifact present (${effectivePath}) — marking ok per R9`);
                  state.steps[step.name] = { status: "ok", essential, duration: Math.round((Date.now() - start) / 100) / 10 };
                  writeStateFile(statePath, state);
                  emitSleepEvent(options.onEvent, { type: "step_completed", runId, step: toSummary(step.name, "completed", essential, state.steps[step.name]!) });
                  continue;
                }
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
          if (step.name === "retrospective") vars.RETRO_CONTENT = response;

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
            const effectivePath = dailySummaryPath ?? state.steps["daily-summary"]?.path;
            if (effectivePath && existsSync(effectivePath) && readDailyArtifact(effectivePath).usable) {
              logInfo(TAG, `[SLEEP] retrospective empty response but artifact present (${effectivePath}) — marking ok per R9`);
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
        if (!cancelled) questionStore.reconcile(primaryUserId, now());

        const step05Ok = state.steps["contradiction-and-graph"]?.status === "ok";
        const retained = vars.CONTRADICTION_AND_GRAPH_OUTPUT;
        // A later terminal model failure makes the assembled run untrustworthy
        // too.  Do not persist a question from step 05 when settlement will
        // report the run as failed and resumable.
        if (!cancelled && !terminalModelFailure && step05Ok && typeof retained === "string" && retained.length > 0) {
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
    ...(s?.failure ? { failure: s.failure } : {}),
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

    // One bounded statement over both current evidence rows, owner-scoped.
    const rows = ctx.memDb.prepare(
      `SELECT id, user_id, valid_to, classification, semantic_revision
       FROM extracted_memories WHERE id IN (?, ?) AND user_id = ?`,
    ).all(oldId, newId, ctx.userId) as Array<{
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
  terminalFailure?: { stepId: string; reason: SleepModelFailureReason; failure: SleepFailure } | null,
  reviewLine?: string | null,
): SleepRunResult {
  const steps: SleepStepSummary[] = Object.entries(state.steps).map(([id, s]) =>
    toSummary(id, s.status === "ok" ? "completed" : s.status === "timeout" ? "timeout" : s.status === "skipped" ? "skipped" : "failed", s.essential ?? (sleepStepConfig(id)?.essential ?? false), s));
  const essentialFailures = failedEssentials(state);
  const okCount = steps.filter(s => s.status === "completed").length;
  const failCount = steps.filter(s => s.status === "failed" || s.status === "timeout").length;
  const skipCount = steps.filter(s => s.status === "skipped").length;

  // #1752: produce exact stage/cause/action report for failed/partial cycles
  const failedEntries: Array<{ id: string; failure: SleepFailure }> = [];
  if (terminalFailure) {
    failedEntries.push({ id: terminalFailure.stepId, failure: terminalFailure.failure });
    // Include any other failed steps besides the terminal one, in terminal order
    for (const [id, s] of Object.entries(state.steps)) {
      if (id === terminalFailure.stepId) continue;
      if (s.status === "failed" || s.status === "timeout") {
        const f = s.failure ?? toBoundedFailure("unknown");
        failedEntries.push({ id, failure: f });
      }
    }
  } else {
    for (const [id, s] of Object.entries(state.steps)) {
      if (s.status === "failed" || s.status === "timeout") {
        const f = s.failure ?? toBoundedFailure("unknown");
        failedEntries.push({ id, failure: f });
      }
    }
  }

  let report: string;
  if ((status === "failed" || status === "partial" || failCount > 0) && failedEntries.length > 0) {
    const primary = failedEntries[0]!;
    const causeDetail = primary.failure.detail ? `${primary.failure.cause} — ${primary.failure.detail}` : `${primary.failure.cause} — ${detailForCause(primary.failure.cause)}`;
    const action = actionForCause(primary.failure.cause);
    const resumeLine = resumable ? "\nResume: /sleep resume" : "";
    let additional = "";
    if (failedEntries.length > 1) {
      const extra = failedEntries.slice(1).map(e => `Additional stage: ${e.id} / Cause: ${e.failure.cause}${e.failure.detail ? ` — ${e.failure.detail.slice(0, 80)}` : ""}`).join("\n");
      additional = `\n${extra}`;
    }
    const review = reviewLine ? `\n${reviewLine}` : "";
    report = `Sleep failed\nStage: ${primary.id}\nCause: ${causeDetail}\nAction: ${action}${resumeLine}${additional}${review}`;
  } else if (terminalFailure) {
    // Fallback for terminal failure without failed entries (should not happen)
    const cause = terminalFailure.failure.cause;
    const detail = terminalFailure.failure.detail ? `${cause} — ${terminalFailure.failure.detail}` : `${cause} — ${detailForCause(cause)}`;
    const action = actionForCause(cause);
    const resumeLine = resumable ? "\nResume: /sleep resume" : "";
    report = `Sleep failed\nStage: ${terminalFailure.stepId}\nCause: ${detail}\nAction: ${action}${resumeLine}${reviewLine ? `\n${reviewLine}` : ""}`;
  } else {
    report = `Sleep ${status} — ${okCount} completed, ${failCount} failed, ${skipCount} skipped (of ${steps.length}).`
      + (essentialFailures.length > 0 ? ` Essential failures: ${essentialFailures.join(", ")}.` : "")
      + (reviewLine ? ` ${reviewLine}` : "");
  }
  // Cap report at 4000 chars
  if (report.length > 4000) report = report.slice(0, 4000);
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
