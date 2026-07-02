#!/usr/bin/env node
/**
 * abmind sleep orchestrator — library function for overnight memory maintenance.
 *
 * Called via runSleepCycle({ runtime, level, ... }). Gathers system state,
 * runs through a pipeline of prompt-driven steps (gc-noise, daily-summary,
 * extract-memories, retrospective, retro-derive, etc.), persists audit log, returns result.
 *
 * Library-only — no CLI entry point here. Standalone entry lives in
 * cli/abmind-sleep.ts.
 *
 * Flags (passed via RunOpts.flags):
 *   --dry-run   Gather state + build prompts, print to stdout, skip LLM calls
 *   --verbose   Detailed logging at each orchestration step
 *   --force     Run housekeeping even if no messages since last sleep
 */

import { localISO } from "../local-time.js";
import { getAbmindEnv } from "../env-schema.js";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { atomicWriteSync } from "../atomic-write.js";
import { MemoryManager } from "../memory-manager.js";
import { loadMemoryConfig } from "../memory-config.js";
import { SleepStateGatherer } from "../sleep-state-gatherer.js";
import { SleepDataAccess } from "../sleep-data-access.js";
import { loadSleepSteps, buildSleepVars, substituteVars } from "../sleep-pipeline.js";
import { buildDailySummary, writeDailyFile, LLMUnavailableError } from "../sleep-pipeline.js";
import { extractFromDaily } from "../sleep-pipeline.js";
import { logInfo, logWarn, logError } from "../mem-logger.js";
import { redactSecrets } from "../redact-secrets.js";
import type { StateSnapshot } from "../sleep-state-gatherer.js";
import { localDate } from "../local-time.js";
import type { SleepStep } from "../sleep-pipeline.js";
import type { SleepRuntime } from "./runtime.js";
import { type Level, parseLevel, DEFAULT_LEVEL } from "./levels.js";

const TAG = "abmind-sleep";

/** Format a timestamp as YYYYMMDD (for lock file names). */
function toDateStr(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** Format a timestamp as YYYY-MM-DD (for daily file paths). */
function toIsoDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Steps whose failure blocks watermark advance. Public so tests can derive reject targets. */
export const ESSENTIAL_STEPS: ReadonlySet<string> = new Set(["daily-summary", "extract-memories", "retrospective"]);
const CATCHUP_MAX_AGE_DAYS = 3;

/** Thrown by runSleepCycle when memory layer fails to initialize. */
export class SleepInitError extends Error {
  constructor(message: string) { super(message); this.name = "SleepInitError"; }
}

/** Thrown by runSleepCycle when the wall-clock timeout expires before completion. */
export class SleepTimeoutError extends Error {
  constructor(message: string) { super(message); this.name = "SleepTimeoutError"; }
}

/** Step-lifecycle event fired by the orchestrator at each step boundary (#895).
 *  Best-effort — a throwing handler must never break memory consolidation. */
export interface SleepStepEvent {
  /** Step name, e.g. "extract-memories". */
  name: string;
  /** Source filename, e.g. "03-extract-memories.md". */
  filename: string;
  /** 1-based step index within the run. */
  index: number;
  /** Total steps in this run (loaded from loadSleepSteps() at cycle start). */
  total: number;
  /** "start" fired before the step runs, "done"/"skipped"/"failed" on resolution. */
  phase: "start" | "done" | "skipped" | "failed";
}

/** Best-effort onStep invoker — swallow handler errors so a display callback
 *  can never break the pipeline. */
function fireOnStep(handler: ((e: SleepStepEvent) => void) | undefined, e: SleepStepEvent): void {
  if (!handler) return;
  try { handler(e); } catch { /* host display only — never fail the cycle */ }
}

/** Options for runSleepCycle. All optional — defaults preserve current main() behavior. */
export interface RunOpts {
  flags?: RawArgs;
  runtime: SleepRuntime;
  /** Which prompt set to run. Defaults to SLEEP_QUALITY env or "normal". */
  level?: Level;
  /** Discard prior state and start with a clean budget. Used by /sleep now. */
  fresh?: boolean;
  /** Inject a deterministic clock for decision sites (today/weekday/startedAt). Observations use real Date.now. */
  now?: () => number;
  /** Override the wall-clock timeout in ms. Default from SLEEP_TIMEOUT_MIN env. */
  timeoutMs?: number;
  /** Override inter-step backoff. Default: [10,30,60]s on consecutive failures. Tests: () => 0. */
  backoffMs?: (consecutiveFailures: number) => number;
  /** Override intra-step retry delay in ms. Default: 6000. Tests: 0. */
  retryDelayMs?: number;
  /** Override memory config (temp dirs in tests). */
  memoryConfigOverride?: Partial<import("../memory-config.js").MemoryConfig>;
  /** Step-lifecycle hook (#895) — fired at each step boundary.
   *  Display-only: a throwing handler never breaks the cycle. */
  onStep?: (e: SleepStepEvent) => void;
  /** Hook fired once at the start of a cycle (before any step runs).
   *  Used by hosts to create a stepped card, reset per-night state, etc. */
  onCycleStart?: (e: { totalSteps: number }) => void;
}

/** Result of runSleepCycle — thrown errors handled separately. */
export interface RunResult {
  ok: boolean;
  failCount: number;
}

// ── Argument parsing ────────────────────────────────────────────────────────

export type RawArgs = { dryRun: boolean; verbose: boolean; force: boolean };

export function parseArgs(argv: string[]): RawArgs {
  const args = argv.slice(2);
  const parsed: RawArgs = { dryRun: false, verbose: false, force: false };

  for (const arg of args) {
    switch (arg) {
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--verbose":
        parsed.verbose = true;
        break;
      case "--force":
        parsed.force = true;
        break;
    }
  }

  return parsed;
}

// ── Audit trail types ───────────────────────────────────────────────────────

interface AuditLogEntry {
  timestamp: string;
  model: string;
  stateSnapshotSummary: string;
  subagentResponse: string;
  outcomes: {
    filesConsolidated: number;
    messagesPruned: number;
    embeddingsRemoved: number;
    sessionsCleaned: number;
    topicsMerged: number;
    topicsDeleted: number;
  };
  error?: string;
}

// ── Subagent invocation ─────────────────────────────────────────────────────

/**
 * Invoke the subagent with the sleep prompt.
 *
 * Uses the MemoryManager's LLM callback (wired via transport in main.ts)
 * when available. For standalone CLI usage, initializes its own transport.
 *
 * The subagent is granted Abtars tools access through the transport's
 * session mechanism — the Kiro CLI agent has full tool access.
 */
/** LLM call entry for sleep steps — caller provides the runtime via RunOpts. */

// ── State file types ────────────────────────────────────────────────────────

type StepStatus = "ok" | "failed" | "skipped" | "pending" | "timeout";
type StepResult = { status: StepStatus; duration?: number; attempts?: number; ctxBefore?: number; ctxAfter?: number; path?: string };
type WiredResults = { purged: number; deduped: number; embedded: number; anomaliesFixed: number; walOk: boolean; ftsOk: boolean; logsDeleted: number };
type SleepStatus = "ongoing" | "completed" | "suspended" | "failed";
type SleepState = { status: SleepStatus; pid: number; startedAt: number; llmCalls: number; wiredResults?: WiredResults; steps: Record<string, StepResult> };




// getPrimaryUserId moved to SleepDataAccess in memory package

function readStateFile(path: string): SleepState | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof raw !== "object" || raw === null || !raw.steps) return null;
    // Backfill defaults for legacy lock files
    if (!raw.status) raw.status = "ongoing";
    if (raw.llmCalls == null) raw.llmCalls = 0;
    return raw as SleepState;
  } catch { return null; }
}

function writeStateFile(path: string, state: SleepState): void {
  atomicWriteSync(path, JSON.stringify(state, null, 2));
}

// ── Wired pre-tasks (delegated to abmind MaintenanceService) ────────────────

async function runWiredPreTasks(sleepData: SleepDataAccess, memoryDir: string, memory: MemoryManager): Promise<WiredResults> {
  const r = await memory.maintenance.runPreSleepTasks(memory, sleepData);

  // Bridge-side: log rotation (not memory's concern)
  let logsDeleted = 0;
  try {
    const logsDir = join(memoryDir, "..", "logs");
    if (existsSync(logsDir)) {
      const cutoff = Date.now() - 7 * 86400000;
      for (const f of readdirSync(logsDir)) {
        if (!f.startsWith("bridge-") || !f.endsWith(".log")) continue;
        const match = f.match(/bridge-(\d{4}-\d{2}-\d{2})\.log/);
        if (match && new Date(match[1]!).getTime() < cutoff) {
          unlinkSync(join(logsDir, f));
          logsDeleted++;
        }
      }
    }
  } catch (err) { logWarn(TAG, `[WIRED] log rotation: ${err instanceof Error ? err.message : String(err)}`); }

  return { purged: r.purged, deduped: r.deduped, embedded: r.embedded, anomaliesFixed: r.anomaliesFixed, walOk: r.walOk, ftsOk: r.ftsOk, logsDeleted };
}


function formatWiredResults(r: WiredResults): string {
  const parts: string[] = [];
  if (r.purged > 0) parts.push(`${r.purged} garbage purged`);
  if (r.deduped > 0) parts.push(`${r.deduped} dupes deleted`);
  parts.push(`WAL ${r.walOk ? "ok" : "FAILED"}`);
  parts.push(`FTS ${r.ftsOk ? "ok" : "FAILED"}`);
  if (r.embedded > 0) parts.push(`${r.embedded} embedded`);
  if (r.anomaliesFixed > 0) parts.push(`${r.anomaliesFixed} anomalies fixed`);
  if (r.logsDeleted > 0) parts.push(`${r.logsDeleted} old logs deleted`);
  return parts.length > 0 ? parts.join(", ") : "nothing to do";
}

// ── Transport ───────────────────────────────────────────────────────────────

// (SleepRuntime is imported at the top of the file.)

const MAX_RETRIES = 3;

/** Budget tracker — shared across all sendWithRetry calls in a sleep cycle. */
class LlmBudget {
  private state: SleepState;
  private readonly statePath: string;
  exhausted = false;

  constructor(state: SleepState, statePath: string) {
    this.state = state;
    this.statePath = statePath;
  }

  /** Increment counter, return false if budget exhausted. */
  consume(): boolean {
    this.state.llmCalls = (this.state.llmCalls ?? 0) + 1;
    writeStateFile(this.statePath, this.state);
    if (this.state.llmCalls > getAbmindEnv().sleepMaxLlmCalls) {
      this.exhausted = true;
      return false;
    }
    return true;
  }

  get calls(): number { return this.state.llmCalls ?? 0; }
}

async function sendWithRetry(
  runtime: SleepRuntime,
  prompt: string,
  stepName: string,
  _verbose: boolean,
  budget?: LlmBudget,
  delayMs = 6000,
): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (budget && !budget.consume()) {
      logWarn(TAG, `[BUDGET] LLM call limit (${getAbmindEnv().sleepMaxLlmCalls}) reached at step ${stepName} — suspending`);
      return null;
    }
    try {
      const result = await runtime.complete(prompt);
      if (!result || !result.trim()) {
        logWarn(TAG, `Step ${stepName} attempt ${attempt}/${MAX_RETRIES} returned empty response`);
        if (attempt === MAX_RETRIES) {
          logError(TAG, `Step ${stepName} failed after ${MAX_RETRIES} attempts (empty), skipping`);
          return null;
        }
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `Step ${stepName} attempt ${attempt}/${MAX_RETRIES} failed: ${msg}`);
      if (attempt === MAX_RETRIES) {
        logError(TAG, `Step ${stepName} failed after ${MAX_RETRIES} attempts, skipping`);
        return null;
      }
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return null;
}


// ── Audit trail helpers ─────────────────────────────────────────────────────

function buildSnapshotSummary(snapshot: StateSnapshot): string {
  return [
    `Working dirs: ${snapshot.workingDirs.length}`,
    `Messages: ${snapshot.dbStats.messageCount}`,
    `Embeddings: ${snapshot.dbStats.embeddingCount}`,
    `Extracted memories: ${snapshot.dbStats.extractedMemoryCount}`,
    `Disk: ${(snapshot.diskUsageBytes / 1024 / 1024).toFixed(1)} MB / ${(snapshot.diskBudgetBytes / 1024 / 1024).toFixed(0)} MB`,
    `Topics: ${snapshot.topicFiles.length}`,
    `FTS5: messages=${snapshot.fts5Health.messages_fts}, extracted=${snapshot.fts5Health.extracted_memories_fts}, original=${snapshot.fts5Health.extracted_memories_original_fts}`,
  ].join(", ");
}

/**
 * Parse outcome counts from the subagent's free-form text response.
 *
 * The subagent response is unstructured text, so we use best-effort regex
 * matching for common patterns like "consolidated 3 files", "pruned 42
 * messages", etc. Returns 0 for any count that can't be parsed.
 */
function parseOutcomesFromResponse(response: string): AuditLogEntry["outcomes"] {
  const defaults: AuditLogEntry["outcomes"] = {
    filesConsolidated: 0,
    messagesPruned: 0,
    embeddingsRemoved: 0,
    sessionsCleaned: 0,
    topicsMerged: 0,
    topicsDeleted: 0,
  };

  if (!response) return defaults;

  const text = response.toLowerCase();

  // Each pattern array contains regexes to try in order for a given outcome.
  // We take the first match found. Patterns cover both "verb N noun" and
  // "N noun verb" orderings that an LLM might produce.
  const patterns: Array<{
    key: keyof typeof defaults;
    regexes: RegExp[];
  }> = [
    {
      key: "filesConsolidated",
      regexes: [
        /consolidat\w*\s+(\d+)\s+(?:file|dir|working)/i,
        /(\d+)\s+(?:file|dir|working\s*dir)\w*\s+consolidat/i,
        /files?\s+consolidated\s*:\s*(\d+)/i,
      ],
    },
    {
      key: "messagesPruned",
      regexes: [
        /prun\w*\s+(\d+)\s+message/i,
        /(\d+)\s+message\w*\s+prun/i,
        /(?:delet|remov)\w*\s+(\d+)\s+message/i,
        /(\d+)\s+message\w*\s+(?:delet|remov)/i,
        /messages?\s+pruned\s*:\s*(\d+)/i,
      ],
    },
    {
      key: "embeddingsRemoved",
      regexes: [
        /(?:remov|delet|clean)\w*\s+(\d+)\s+embedding/i,
        /(\d+)\s+embedding\w*\s+(?:remov|delet|clean)/i,
        /embeddings?\s+removed\s*:\s*(\d+)/i,
      ],
    },
    {
      key: "sessionsCleaned",
      regexes: [
        /(?:clean|delet|remov)\w*\s+(\d+)\s+session/i,
        /(\d+)\s+session\w*\s+(?:clean|delet|remov)/i,
        /sessions?\s+cleaned\s*:\s*(\d+)/i,
      ],
    },
    {
      key: "topicsMerged",
      regexes: [
        /merg\w*\s+(\d+)\s+topic/i,
        /(\d+)\s+topic\w*\s+merg/i,
        /topics?\s+merged\s*:\s*(\d+)/i,
      ],
    },
    {
      key: "topicsDeleted",
      regexes: [
        /delet\w*\s+(\d+)\s+topic/i,
        /(\d+)\s+topic\w*\s+delet/i,
        /topics?\s+deleted\s*:\s*(\d+)/i,
      ],
    },
  ];

  for (const { key, regexes } of patterns) {
    for (const regex of regexes) {
      const match = text.match(regex);
      if (match?.[1]) {
        const parsed = parseInt(match[1], 10);
        if (!isNaN(parsed) && parsed >= 0) {
          defaults[key] = parsed;
          break;
        }
      }
    }
  }

  return defaults;
}

function writeAuditLog(
  memoryDir: string,
  entry: AuditLogEntry,
): void {
  const sleepDir = join(memoryDir, "sleep");
  mkdirSync(sleepDir, { recursive: true });

  const suffix = [
    ``,
    `---`,
    ``,
    `## CLI Wrapper`,
    ``,
    `**Timestamp:** ${entry.timestamp}`,
    `**Model:** ${entry.model}`,
    ``,
    `### State Snapshot`,
    `${entry.stateSnapshotSummary}`,
    ``,
    `### Outcomes`,
    `- Files consolidated: ${entry.outcomes.filesConsolidated}`,
    `- Messages pruned: ${entry.outcomes.messagesPruned}`,
    `- Embeddings removed: ${entry.outcomes.embeddingsRemoved}`,
    `- Sessions cleaned: ${entry.outcomes.sessionsCleaned}`,
    `- Topics merged: ${entry.outcomes.topicsMerged}`,
    `- Topics deleted: ${entry.outcomes.topicsDeleted}`,
    entry.error ? `\n### Error\n${entry.error}` : "",
  ].join("\n");

  // Find the subagent's audit file and append to it
  const today = localDate().replace(/-/g, "");
  try {
    const files = readdirSync(sleepDir)
      .filter(f => f.startsWith(`sleep_${today}`) && f.endsWith(".md"))
      .sort();
    if (files.length > 0) {
      const target = join(sleepDir, files[files.length - 1]!);
      const existingLines = readFileSync(target, "utf-8").split("\n").length;
      if (existingLines < 50) {
        logWarn(TAG, `Sleep audit suspiciously short (${existingLines} lines) — subagent may have truncated`);
      }
      appendFileSync(target, redactSecrets(suffix), "utf-8");
      return;
    }
  } catch { /* fall through to standalone */ }

  // Fallback: no subagent file found — write standalone
  const now = new Date();
  const dateStr = localDate().replace(/-/g, "");
  const timeStr = now.toTimeString().slice(0, 5).replace(/:/g, "");
  const filename = `sleep_${dateStr}_${timeStr}.md`;
  writeFileSync(join(sleepDir, filename), redactSecrets(`# Sleep Audit Log${suffix}`), "utf-8");
}

// ── Catch-up for previous days ──────────────────────────────────────────────

interface PreviousLock {
  path: string;
  dateStr: string; // YYYYMMDD
  state: SleepState;
  ageDays: number;
}

function scanPreviousLocks(sleepDir: string, todayStr: string): PreviousLock[] {
  if (!existsSync(sleepDir)) return [];
  const locks: PreviousLock[] = [];
  const todayMs = dateStrToMs(todayStr);
  for (const f of readdirSync(sleepDir)) {
    const m = f.match(/^sleep_(\d{8})\.lock$/);
    if (!m || m[1] === todayStr) continue;
    const state = readStateFile(join(sleepDir, f));
    if (!state) continue;
    const ageDays = Math.round((todayMs - dateStrToMs(m[1]!)) / 86400000);
    if (ageDays > 0) locks.push({ path: join(sleepDir, f), dateStr: m[1]!, state, ageDays });
  }
  return locks.sort((a, b) => b.dateStr.localeCompare(a.dateStr)); // newest first
}

function dateStrToMs(ds: string): number {
  return new Date(`${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}T00:00:00`).getTime();
}

function dateStrToFormatted(ds: string): string {
  return `${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}`;
}

function failedEssentials(state: SleepState): string[] {
  const failed: string[] = [];
  for (const name of ESSENTIAL_STEPS) {
    const s = state.steps[name];
    if (!s || s.status === "failed" || s.status === "timeout" || s.status === "pending") {
      failed.push(name);
    }
  }
  return failed;
}

async function runCatchUp(
  locks: PreviousLock[],
  sleepData: SleepDataAccess,
  memoryConfig: { memoryDir: string },
  steps: SleepStep[],
  flags: RawArgs,
  runtime: SleepRuntime,
  budget?: LlmBudget,
  retryDelayMs = 6000,
  onStep?: (e: SleepStepEvent) => void,
): Promise<void> {
  for (const lock of locks) {
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
      try {
        const ctxWindow = getAbmindEnv().sleepCtxWindow;
        const userId = sleepData.getPrimaryUserId();
        const dayStart = dateStrToMs(lock.dateStr);
        const dayEnd = dayStart + 86400000;
        const summary = await buildDailySummary(sleepData.getDb(), (p) => sendWithRetry(runtime, p, "catch-up-04a", flags.verbose, budget, retryDelayMs).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }), {
          ctxWindow, memoryDir: memoryConfig.memoryDir, userId, watermarkTs: 0,
          dateRange: { startTs: dayStart, endTs: dayEnd },
        });
        if (summary) {
          writeDailyFile(memoryConfig.memoryDir, dateStrToFormatted(lock.dateStr), summary);
          lock.state.steps["daily-summary"] = { status: "ok", duration: Math.round((Date.now() - start) / 100) / 10 };
        } else {
          lock.state.steps["daily-summary"] = { status: "skipped" };
        }
        logInfo(TAG, `[CATCH-UP] ✓ 04a-daily-summary for ${lock.dateStr} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
        // #895: emit terminal event for catch-up daily-summary
        fireOnStep(onStep, {
          name: "daily-summary", filename: "catch-up",
          index: 0, total: 0,
          phase: summary ? "done" : "skipped",
        });
      } catch (err) {
        logWarn(TAG, `[CATCH-UP] ✗ 04a-daily-summary for ${lock.dateStr}: ${err instanceof Error ? err.message : String(err)}`);
        lock.state.steps["daily-summary"] = { status: "failed", duration: Math.round((Date.now() - start) / 100) / 10 };
        // #895: emit failed for catch-up daily-summary
        fireOnStep(onStep, {
          name: "daily-summary", filename: "catch-up",
          index: 0, total: 0,
          phase: "failed",
        });
      }
      writeStateFile(lock.path, lock.state);
    }

    // 04b — extract memories from daily (needs daily file to exist)
    if (needed.includes("extract-memories")) {
      const dailyPath = join(memoryConfig.memoryDir, "daily", `daily_${dateStrToFormatted(lock.dateStr)}.md`);
      if (!existsSync(dailyPath)) {
        logInfo(TAG, `[CATCH-UP] ⏭ 04b — no daily file for ${lock.dateStr}`);
        lock.state.steps["extract-memories"] = { status: "skipped" };
        // #895: emit skip when no daily file for catch-up
        fireOnStep(onStep, {
          name: "extract-memories", filename: "catch-up",
          index: 0, total: 0,
          phase: "skipped",
        });
      } else {
        const start = Date.now();
        try {
          const userId = sleepData.getPrimaryUserId();
          const result = await extractFromDaily(dailyPath, userId, (p) => sendWithRetry(runtime, p, "catch-up-04b", flags.verbose, budget, retryDelayMs).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }));
          lock.state.steps["extract-memories"] = { status: "ok", duration: Math.round((Date.now() - start) / 100) / 10 };
          logInfo(TAG, `[CATCH-UP] ✓ 04b-extract-memories for ${lock.dateStr} (${((Date.now() - start) / 1000).toFixed(1)}s) — ${result.slice(0, 80)}`);
          // #895: emit done for catch-up extract-memories
          fireOnStep(onStep, {
            name: "extract-memories", filename: "catch-up",
            index: 0, total: 0,
            phase: "done",
          });
        } catch (err) {
          logWarn(TAG, `[CATCH-UP] ✗ 04b for ${lock.dateStr}: ${err instanceof Error ? err.message : String(err)}`);
          lock.state.steps["extract-memories"] = { status: "failed", duration: Math.round((Date.now() - start) / 100) / 10 };
          // #895: emit failed for catch-up extract-memories
          fireOnStep(onStep, {
            name: "extract-memories", filename: "catch-up",
            index: 0, total: 0,
            phase: "failed",
          });
        }
      }
      writeStateFile(lock.path, lock.state);
    }

    // Prompt-driven essentials (retrospective — now includes extraction)
    for (const stepName of ["retrospective"] as const) {
      if (!needed.includes(stepName)) continue;
      const step = steps.find(s => s.name === stepName);
      if (!step) { logWarn(TAG, `[CATCH-UP] Step file not found: ${stepName}`); continue; }
      const start = Date.now();
      const response = await sendWithRetry(runtime, step.rawPrompt, `catch-up-${stepName}`, flags.verbose, budget, retryDelayMs);
      if (response) {
        lock.state.steps[stepName] = { status: "ok", duration: Math.round((Date.now() - start) / 100) / 10 };
        logInfo(TAG, `[CATCH-UP] ✓ ${stepName} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
        // #895: emit done for catch-up retrospective
        fireOnStep(onStep, {
          name: stepName, filename: "catch-up",
          index: 0, total: 0,
          phase: "done",
        });
      } else {
        lock.state.steps[stepName] = { status: "failed", duration: Math.round((Date.now() - start) / 100) / 10 };
        logWarn(TAG, `[CATCH-UP] ✗ ${stepName}`);
        // #895: emit failed for catch-up retrospective
        fireOnStep(onStep, {
          name: stepName, filename: "catch-up",
          index: 0, total: 0,
          phase: "failed",
        });
      }
      writeStateFile(lock.path, lock.state);
    }

    // Final check: all essentials recovered?
    const stillFailing = failedEssentials(lock.state);
    if (stillFailing.length === 0) {
      logInfo(TAG, `[CATCH-UP] ✅ ${basename(lock.path)} — all essentials recovered, lock deleted`);
      unlinkSync(lock.path);
    } else {
      logWarn(TAG, `[CATCH-UP] ${basename(lock.path)} — still failing: ${stillFailing.join(", ")} (failing ${lock.ageDays} day(s))`);
    }
  }
}

// ── Main orchestration ──────────────────────────────────────────────────────

/**
 * Run the full sleep cycle. Extracted from main() for testability (#175).
 * - Deterministic time injection via opts.now for decision sites
 * - Throws SleepInitError / SleepTimeoutError instead of process.exit
 * - Returns { ok, failCount } for observable outcomes
 *
 * Default args preserve current main() behavior exactly.
 */
export async function runSleepCycle(opts: RunOpts): Promise<RunResult> {
  const flags = opts.flags ?? parseArgs(process.argv);
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? getAbmindEnv().sleepTimeoutMin * 60 * 1000;
  const backoffMs = opts.backoffMs ?? ((n: number) => [10, 30, 60][Math.min(n, 2)]! * 1000);
  const retryDelayMs = opts.retryDelayMs ?? 6000;
  const runtime = opts.runtime;

  if (flags.verbose) {
    logInfo(TAG, "Verbose mode enabled");
  }

  const memoryConfig = { ...loadMemoryConfig(), ...opts.memoryConfigOverride };
  const memory = new MemoryManager(memoryConfig);

  try {
    await memory.initialize();
  } catch (err) {
    throw new SleepInitError(`Failed to initialize MemoryManager: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 0: run abmind doctor --fix to repair any FTS corruption before sleep steps
  try {
    const { execSync } = await import("node:child_process");
    execSync("abmind doctor --fix", { timeout: 30_000, stdio: "ignore" });
  } catch { /* non-fatal — proceed with sleep */ }

  try {
    const sleepData = memory.getSleepData();
    const db = (memory as any).db; // access DB for meta writes

    // TTL: clean ephemeral system/agent messages older than 24h
    try { db.prepare("DELETE FROM messages WHERE user_id IN ('system', 'agent') AND timestamp < ?").run(Date.now() - 86_400_000); } catch { /* */ }

    const { metaSet, metaIncrement, metaGetInt } = await import("../meta-store.js");

    // Record attempt
    metaSet(db, "sleep_last_attempt_ts", Date.now());
    metaIncrement(db, "sleep_total_runs");

    // State file path — use opts.now for deterministic today derivation
    const dateStr = toDateStr(now());
    const statePath = join(memoryConfig.memoryDir, "sleep", `sleep_${dateStr}.lock`);
    const existingState = readStateFile(statePath);

    // #518: PID guard — prevent concurrent sleep execution
    if (existingState?.status === "ongoing") {
      let alive = false;
      try { process.kill(existingState.pid, 0); alive = true; } catch {}
      if (alive) {
        logInfo(TAG, `[SLEEP] Already running (pid ${existingState.pid}) — skipping`);
        return { ok: true, failCount: 0 };
      }
      logWarn(TAG, `[SLEEP] Stale lock (pid ${existingState.pid} dead) — claiming`);
    }

    // #1082: Fresh cycle discards prior state (budget + steps)
    const isResume = !opts.fresh && existingState !== null && Object.values(existingState.steps).some(s => s.status === "ok");

    // Gather state
    // cron integration is caller-owned (bridge-only). Abmind library runs without cron awareness.
    const cronFn: (() => string | null) | undefined = undefined;
    const gatherer = new SleepStateGatherer(memory, memoryConfig, cronFn);
    const snapshot = await gatherer.gather();
    if (flags.verbose) logInfo(TAG, `State gathered: ${buildSnapshotSummary(snapshot)}`);

    // Guardrail: skip if no messages since last sleep (unless --force or resuming)
    const msgCount = snapshot.dbStats.messagesSinceLastSleep;
    if (msgCount === 0 && !flags.force && !isResume) {
      logInfo(TAG, `[SLEEP] No messages since last sleep — nothing to process. Use --force to run housekeeping anyway.`);
      // Write minimal audit marker so hasSleepAuditToday() returns true (prevents bedtime re-trigger)
      const sleepDir = join(memoryConfig.memoryDir, "sleep");
      mkdirSync(sleepDir, { recursive: true });
      const dateStr = localDate().replace(/-/g, "");
      const timeStr = new Date().toTimeString().slice(0, 5).replace(/:/g, "");
      writeFileSync(join(sleepDir, `sleep_${dateStr}_${timeStr}.md`), `# Sleep Audit Log\n\n## No work — 0 messages since last sleep\n`, "utf-8");
      return { ok: true, failCount: 0 };
    }

    // Wired pre-tasks (always run — fast, idempotent)
    logInfo(TAG, `[SLEEP] Running wired pre-tasks${isResume ? " (resume)" : ""}...`);
    const wiredResults = await runWiredPreTasks(sleepData, memoryConfig.memoryDir, memory);
    logInfo(TAG, `[SLEEP] Wired: ${formatWiredResults(wiredResults)}`);

    // Build candidate lists for conditional prompts
    const candidates = sleepData.buildSleepCandidates(getAbmindEnv().sleepModelName ?? "unknown");
    logInfo(TAG, `[SLEEP] Candidates: topics=${candidates.untaggedMemories ? "yes" : "none"}, promote=${candidates.promotionCandidates ? "yes" : "none"}, contradict=${candidates.contradictions ? "yes" : "none"}, merge=${candidates.mergeCandidates ? "yes" : "none"}, translate=${candidates.translationIssues ? "yes" : "none"}, emotion-ctx=${candidates.emotionContextGaps ? "yes" : "none"}, feedback=${candidates.recallFeedback ? "yes" : "none"}`);

    // Load step files + build vars
    const vars = buildSleepVars(snapshot);
    vars.WIRED_RESULTS = formatWiredResults(wiredResults);

    // Inject candidate lists as template variables
    vars.UNTAGGED_MEMORIES = candidates.untaggedMemories || "No untagged memories found.";
    vars.PROMOTION_CANDIDATES = candidates.promotionCandidates || "No promotion candidates found.";
    vars.CONTRADICTION_WARNINGS = candidates.contradictions || "";
    vars.MERGE_CANDIDATES = candidates.mergeCandidates || "No merge candidates found.";
    vars.TRANSLATION_ISSUES = candidates.translationIssues || "No translation issues found.";
    vars.EMOTION_CONTEXT_GAPS = candidates.emotionContextGaps || "No emotion context gaps found.";
    vars.RECALL_FEEDBACK = candidates.recallFeedback || "No recalls happened today.";

    // Skill dedup candidates (for step 10 skill-review)
    {
      const { detectSkillDuplicates, formatDedupCandidates } = await import("./skill-dedup.js");
      const abtarsHome = process.env["ABTARS_HOME"] ?? join(process.env["HOME"] ?? "", ".abtars");
      const coreSkillsDir = join(abtarsHome, "skills", "core");
      const selfSkillsDir = join(abtarsHome, "skills", "self");
      const dedupCandidates = detectSkillDuplicates(coreSkillsDir, selfSkillsDir);
      vars.DEDUP_CANDIDATES = formatDedupCandidates(dedupCandidates) || "No skill duplicates or overlaps detected.";
    }
    vars.WIRED_RESULTS = formatWiredResults(wiredResults);
    vars.RESUME_CONTEXT = isResume
      ? `This is a RESUMED sleep cycle. Steps already completed: ${Object.entries(existingState!.steps).filter(([, s]) => s.status === "ok" || s.status === "skipped").map(([k]) => k).join(", ")}. Only pending/failed steps will run.`
      : "Fresh sleep cycle — all steps will run.";

    // Pre-query messages for retro (watermark-scoped, noise-stripped)
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

    // Set remaining missing vars
    vars.MESSAGES_SINCE_WATERMARK = vars.CLEAN_MESSAGES; // same data, different name for gc-noise
    vars.RETRO_PATH = join(memoryConfig.memoryDir, "daily", `daily_${toIsoDate(now())}.md`);
    vars.DAILY_PATH = vars.RETRO_PATH; // step 03 appends retro to the daily file
    try {
      const { getLatestConsolidationFile } = await import("../consolidation-search.js");
      const latest = getLatestConsolidationFile(memoryConfig.memoryDir, "weekly");
      vars.CONSOLIDATION_PATH = latest?.filePath ?? "No consolidation files yet.";
    } catch { vars.CONSOLIDATION_PATH = "No consolidation files yet."; }

    // Output path for consolidation — weekly or quarterly
    const todayIso = new Date(now()).toISOString().slice(0, 10); // YYYY-MM-DD
    const weeklyDir = join(memoryConfig.memoryDir, "weekly");
    const quarterlyDir = join(memoryConfig.memoryDir, "quarterly");
    mkdirSync(weeklyDir, { recursive: true });
    mkdirSync(quarterlyDir, { recursive: true });
    const month = new Date(now()).getMonth(); // 0-based
    const isQuarterBoundary = month % 3 === 0 && new Date(now()).getDate() <= 7;
    if (isQuarterBoundary) {
      vars.CONSOLIDATION_OUTPUT_PATH = join(quarterlyDir, `quarterly_${todayIso}.md`);
    } else {
      vars.CONSOLIDATION_OUTPUT_PATH = join(weeklyDir, `weekly_${todayIso}.md`);
    }

    const steps = loadSleepSteps();
    // Merge snapshot vars + bridge vars into one map for JIT substitution
    const snapshotVars = buildSleepVars(snapshot);
    for (const [k, v] of Object.entries(snapshotVars)) vars[k] = vars[k] ?? v;

    // #895: Fire onCycleStart once before the first step — hosts use this to
    // create a stepped card or reset per-night state. fireOnStep() already
    // swallows handler errors so a misbehaving host can never break the cycle.
    try { opts.onCycleStart?.({ totalSteps: steps.length }); } catch { /* host display only */ }

    // Progress protocol — emit PROGRESS:<pct>:<label> on stdout
    const totalSteps = steps.length;
    let stepIndex = 0;
    const emitProgress = (label: string): void => {
      const pct = Math.round((stepIndex / totalSteps) * 100);
      process.stdout.write(`PROGRESS:${pct}:${label}\n`);
    };

    if (flags.dryRun) {
      for (const step of steps) process.stdout.write(`\n--- ${step.filename} ---\n${substituteVars(step.rawPrompt, vars)}\n`);
      return { ok: true, failCount: 0 };
    }

    // Skip logic — candidate-driven (empty = skip)
    const skipSet = new Set<string>();

    // Level tiering — controls which prompts are eligible.
    // Precedence: opts.level > SLEEP_QUALITY env (legacy bridge path) > DEFAULT_LEVEL.
    const quality: Level = opts.level ?? (getAbmindEnv().sleepQuality ? parseLevel(getAbmindEnv().sleepQuality!) : DEFAULT_LEVEL);
    const curationDay = getAbmindEnv().sleepCurationDay;
    const today = new Date(now()).toLocaleDateString("en", { weekday: "long" }).toLowerCase();
    const isCurationDay = today === curationDay;

    const BUDGET_ONLY = new Set(["gc-noise", "daily-summary", "extract-memories"]);
    const BUDGET_CURATION = new Set([...BUDGET_ONLY, "retrospective", "retro-derive"]);
    const WEEKLY_ONLY = new Set(["memory-maintenance", "translation",
      "skill-review", "consolidation", "rem-synthesis"]);

    if (quality === "budget" && !isCurationDay) {
      for (const step of steps) {
        if (!BUDGET_ONLY.has(step.name)) skipSet.add(step.name);
      }
      logInfo(TAG, `[SLEEP] Quality=budget — only essential extraction`);
    } else if (quality === "budget" && isCurationDay) {
      for (const step of steps) {
        if (!BUDGET_CURATION.has(step.name)) skipSet.add(step.name);
      }
      logInfo(TAG, `[SLEEP] Quality=budget (curation day) — adds retro + derive`);
    } else if (quality === "normal" && !isCurationDay) {
      for (const name of WEEKLY_ONLY) skipSet.add(name);
      logInfo(TAG, `[SLEEP] Quality=normal — weekly prompts skipped (curation day: ${curationDay})`);
    } else if (quality === "normal" && isCurationDay) {
      logInfo(TAG, `[SLEEP] Quality=normal (curation day) — all steps`);
    } else {
      // ultimate: all steps every night
      logInfo(TAG, `[SLEEP] Quality=${quality}${isCurationDay ? " (curation day)" : ""} — all eligible`);
    }

    // Candidate-driven skips (empty = nothing to do)
    if (!candidates.recallFeedback) skipSet.add("feedback");
    // memory-maintenance: skip if ALL three inputs are empty
    if (!candidates.untaggedMemories && !candidates.mergeCandidates && !candidates.emotionContextGaps) skipSet.add("memory-maintenance");
    // promotion candidates are optional input to retro-derive — don't skip the step for it
    if (!candidates.translationIssues) skipSet.add("translation");
    // Legacy skip names (old prompt files)
    if (snapshot.topicFiles.length === 0) skipSet.add("topic-reorg");
    if (snapshot.dbStats.extractedMemoryCount < 10) { skipSet.add("memory-maintenance"); skipSet.add("darwinism"); }
    if (snapshot.dbStats.extractedMemoryCount < 20) skipSet.add("rem-synthesis");
    try { if (!existsSync(join(memoryConfig.memoryDir, "..", "received"))) skipSet.add("media-cleanup"); } catch { /* */ }
    try {
      const shortCount = sleepData.getShortMessageCount();
      if (shortCount === 0) skipSet.add("gc-noise");
    } catch { /* */ }

    // Initialize state file
    const state: SleepState = existingState ?? {
      status: "ongoing",
      pid: process.pid,
      startedAt: now(),
      llmCalls: 0,
      wiredResults,
      steps: {},
    };
    state.status = "ongoing";
    state.pid = process.pid;
    state.wiredResults = wiredResults;

    // 20-min wall-clock timeout
    const timeoutHandle = setTimeout(() => {
      logError(TAG, `[SLEEP] ⏰ ${Math.round(timeoutMs / 60000)}-minute timeout reached — aborting`);
      throw new SleepTimeoutError(`Sleep cycle timeout after ${Math.round(timeoutMs / 60000)} minutes`);
    }, timeoutMs);

    // Resolve model name for logging. Bridge wraps and passes via env; library default is "unknown".
    const modelUsed = getAbmindEnv().sleepModelName;
    let dreamySucceeded = true;
    let dailySummaryPath: string | null = null;

    try {
      // ── LLM call budget (hard safety limit) ──
      // On resume: reset llmCalls to completed step count (don't carry stale counter)
      if (isResume) {
        const completedCount = Object.values(state.steps).filter(s => s.status === "ok").length;
        state.llmCalls = completedCount;
      }
      const budget = new LlmBudget(state, statePath);

      // ── Catch-up: recover failed essentials from previous days ──
      const sleepDir = join(memoryConfig.memoryDir, "sleep");
      const previousLocks = scanPreviousLocks(sleepDir, dateStr);
      if (previousLocks.length > 0) {
        logInfo(TAG, `[CATCH-UP] Found ${previousLocks.length} previous lock(s)`);
        await runCatchUp(previousLocks, sleepData, memoryConfig, steps, flags, runtime, budget, retryDelayMs, opts.onStep);
      }

      // Housekeeping: move misplaced daily/consolidation_* to weekly/ (#640)
      try {
        const dailyDir = join(memoryConfig.memoryDir, "daily");
        if (existsSync(dailyDir)) {
          for (const f of readdirSync(dailyDir).filter(fn => fn.startsWith("consolidation_"))) {
            const m = f.match(/consolidation_(\d{4})-(\d{2})-week(\d)/);
            if (m) {
              const [, year, month, week] = m;
              const day = (parseInt(week!) - 1) * 7 + 1;
              const approxDate = `${year}-${month}-${String(Math.min(day, 28)).padStart(2, "0")}`;
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

      emitProgress("starting");
      let consecutiveFailures = 0;

      // Create day directory for per-step logs
      const stepLogDir = join(sleepDir, dateStr);
      mkdirSync(stepLogDir, { recursive: true });

      // Load Dreamy identity (context injection, prepended to first step only)
      const userSoul = join(memoryConfig.memoryDir, "..", "prompts", "sleep", "SOUL-Dreamy.md");
      const pkgSoul = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts", "sleep", "SOUL-Dreamy.md");
      const soulPath = existsSync(userSoul) ? userSoul : pkgSoul;
      let soulPrefix = existsSync(soulPath) ? readFileSync(soulPath, "utf-8") + "\n\n---\n\n" : "";

      for (const step of steps) {
        // Hard safety: LLM call budget exhausted → suspend
        if (budget.exhausted) {
          logWarn(TAG, `[BUDGET] Suspending sleep — ${budget.calls}/${getAbmindEnv().sleepMaxLlmCalls} LLM calls used`);
          state.status = "suspended";
          writeStateFile(statePath, state);
          break;
        }

        emitProgress(step.name);
        stepIndex++;

        // #895: "start" fires once per step (before skip checks) so every step
        // emits exactly one start + one terminal (done/skipped/failed). Display-only,
        // best-effort — a throwing handler never breaks the cycle.
        fireOnStep(opts.onStep, { name: step.name, filename: step.filename, index: stepIndex, total: totalSteps, phase: "start" });

        // Resume: skip already completed steps
        if (isResume && existingState?.steps[step.name]?.status === "ok") {
          logInfo(TAG, `[SLEEP] ⏭ ${step.name} — already done (resume)`);
          fireOnStep(opts.onStep, { name: step.name, filename: step.filename, index: stepIndex, total: totalSteps, phase: "skipped" });
          continue;
        }
        if (isResume && existingState?.steps[step.name]?.status === "skipped") {
          logInfo(TAG, `[SLEEP] ⏭ ${step.name} — skipped (resume)`);
          fireOnStep(opts.onStep, { name: step.name, filename: step.filename, index: stepIndex, total: totalSteps, phase: "skipped" });
          continue;
        }

        // Skip logic (essential steps always run)
        if (step.skippable && skipSet.has(step.name)) {
          logInfo(TAG, `[SLEEP] ⏭ ${step.name} — skipped`);
          state.steps[step.name] = { status: "skipped" };
          writeStateFile(statePath, state);
          fireOnStep(opts.onStep, { name: step.name, filename: step.filename, index: stepIndex, total: totalSteps, phase: "skipped" });
          continue;
        }

        const start = Date.now();
        logInfo(TAG, `[SLEEP] → ${step.name}`);
        state.steps[step.name] = { status: "pending" };
        writeStateFile(statePath, state);

        // Code-driven steps
        if (step.name === "daily-summary") {
          try {
            const ctxWindow = getAbmindEnv().sleepCtxWindow;
            const userId = sleepData.getPrimaryUserId();
            const watermarkTs = sleepData.getExtractionWatermark(userId);

            // Determine target date from first unprocessed message
            const firstMsgTs = sleepData.getFirstMessageAfter(userId, watermarkTs);
            const firstMsgDate = firstMsgTs ? new Date(firstMsgTs) : new Date(now());
            const targetDate = `${firstMsgDate.getFullYear()}-${String(firstMsgDate.getMonth() + 1).padStart(2, "0")}-${String(firstMsgDate.getDate()).padStart(2, "0")}`;

            const summary = await buildDailySummary(sleepData.getDb(), (p) => sendWithRetry(runtime, p, "daily-summary", flags.verbose, budget, retryDelayMs).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }), {
              ctxWindow, memoryDir: memoryConfig.memoryDir, userId, watermarkTs,
            });
            if (summary) {
              dailySummaryPath = writeDailyFile(memoryConfig.memoryDir, targetDate, summary);
              state.steps[step.name] = { status: "ok", duration: Math.round((Date.now() - start) / 100) / 10, path: dailySummaryPath };
              writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${step.name}.md`), redactSecrets(summary), "utf-8");
            } else {
              state.steps[step.name] = { status: "skipped" };
            }
          } catch (err) {
            logWarn(TAG, `[SLEEP] 04a failed: ${err instanceof Error ? err.message : String(err)}`);
            state.steps[step.name] = { status: "failed", duration: Math.round((Date.now() - start) / 100) / 10 };
            dreamySucceeded = false;
          }
          writeStateFile(statePath, state);
          logInfo(TAG, `[SLEEP] ${state.steps[step.name]?.status === "ok" ? "✓" : "✗"} ${step.name} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
          // #895: emit terminal event for code-driven daily-summary
          fireOnStep(opts.onStep, {
            name: step.name,
            filename: step.filename,
            index: stepIndex,
            total: totalSteps,
            phase: state.steps[step.name]?.status === "ok" ? "done"
              : state.steps[step.name]?.status === "skipped" ? "skipped"
              : "failed",
          });
          continue;
        }

        if (step.name === "extract-memories") {
          // Resume path: if daily-summary already completed in a prior run, the
          // in-memory dailySummaryPath is null. Recover it from the lock's
          // recorded path so extract-memories can still run. #181.
          if (!dailySummaryPath) {
            const priorPath = state.steps["daily-summary"]?.path;
            if (priorPath && existsSync(priorPath)) {
              dailySummaryPath = priorPath;
              logInfo(TAG, `[SLEEP] ${step.name} — recovered daily path from lock (${priorPath})`);
            }
          }
          if (!dailySummaryPath) {
            state.steps[step.name] = { status: "skipped" };
            writeStateFile(statePath, state);
            logInfo(TAG, `[SLEEP] ⏭ ${step.name} — no daily summary`);
            // #895: emit skip when there's no daily summary to extract from
            fireOnStep(opts.onStep, { name: step.name, filename: step.filename, index: stepIndex, total: totalSteps, phase: "skipped" });
            continue;
          }
          try {
            const userId = sleepData.getPrimaryUserId();
            const result = await extractFromDaily(dailySummaryPath, userId, (p) => sendWithRetry(runtime, p, "04b-extract", flags.verbose, budget, retryDelayMs).then(r => { if (r === null) throw new LLMUnavailableError(); return r; }));
            state.steps[step.name] = { status: "ok", duration: Math.round((Date.now() - start) / 100) / 10 };
            writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${step.name}.md`), redactSecrets(result), "utf-8");
            logInfo(TAG, `[SLEEP] ✓ ${step.name} (${((Date.now() - start) / 1000).toFixed(1)}s) — ${result.slice(0, 80)}`);
          } catch (err) {
            logWarn(TAG, `[SLEEP] 04b failed: ${err instanceof Error ? err.message : String(err)}`);
            state.steps[step.name] = { status: "failed", duration: Math.round((Date.now() - start) / 100) / 10 };
            dreamySucceeded = false;
          }
          writeStateFile(statePath, state);
          // #895: emit terminal event for code-driven extract-memories
          fireOnStep(opts.onStep, {
            name: step.name,
            filename: step.filename,
            index: stepIndex,
            total: totalSteps,
            phase: state.steps[step.name]?.status === "ok" ? "done" : "failed",
          });
          continue;
        }

        // Standard prompt-driven step — JIT substitution
        // Populate contradiction+graph vars JIT (needs today's extractions to exist)
        if (step.name === "contradiction-and-graph") {
          try {
            const todayStart = new Date(now());
            todayStart.setHours(0, 0, 0, 0);
            const memDb = memory.getDatabase();
            const newRows = (memDb?.prepare(
              `SELECT id, content_en, memory_type, topic, trust FROM extracted_memories WHERE created_at >= ? AND memory_type != 'observation' ORDER BY created_at DESC LIMIT 30`,
            ).all(todayStart.getTime()) ?? []) as Array<{ id: number; content_en: string; memory_type: string; topic: string | null; trust: number }>;
            if (newRows.length === 0) {
              state.steps[step.name] = { status: "skipped" };
              writeStateFile(statePath, state);
              logInfo(TAG, `[SLEEP] ⏭ ${step.name} — no new extractions today`);
              // #895: emit skip when there's no work for contradiction-and-graph
              fireOnStep(opts.onStep, { name: step.name, filename: step.filename, index: stepIndex, total: totalSteps, phase: "skipped" });
              continue;
            }
            vars.NEW_EXTRACTIONS = newRows.map(r => `[id=${r.id}] (${r.memory_type}, trust=${r.trust}) ${r.content_en}`).join("\n");
            // Find candidates: FTS5 top-5 per new memory, capped at 20 total
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
            state.steps[step.name] = { status: "skipped" };
            writeStateFile(statePath, state);
            // #895: emit skip on var-prep failure
            fireOnStep(opts.onStep, { name: step.name, filename: step.filename, index: stepIndex, total: totalSteps, phase: "skipped" });
            continue;
          }
        }

        // Populate REM sample vars JIT
        if (step.name === "rem-synthesis") {
          try {
            const memDb = memory.getDatabase();
            const sample = memDb?.prepare(
              `SELECT id, content_en, memory_type, created_at FROM extracted_memories WHERE trust >= 2 AND memory_type != 'observation' AND valid_to IS NULL ORDER BY RANDOM() LIMIT 10`,
            ).all() as Array<{ id: number; content_en: string; memory_type: string; created_at: number }> ?? [];
            if (sample.length < 5) {
              state.steps[step.name] = { status: "skipped" };
              writeStateFile(statePath, state);
              logInfo(TAG, `[SLEEP] ⏭ ${step.name} — not enough memories for REM`);
              // #895: emit skip when not enough memories for REM
              fireOnStep(opts.onStep, { name: step.name, filename: step.filename, index: stepIndex, total: totalSteps, phase: "skipped" });
              continue;
            }
            vars.REM_SAMPLE = sample.map(r => `[${r.memory_type}, ${new Date(r.created_at).toISOString().slice(0, 10)}] ${r.content_en}`).join("\n");
          } catch {
            state.steps[step.name] = { status: "skipped" };
            writeStateFile(statePath, state);
            // #895: emit skip on var-prep failure for rem-synthesis
            fireOnStep(opts.onStep, { name: step.name, filename: step.filename, index: stepIndex, total: totalSteps, phase: "skipped" });
            continue;
          }
        }

        const prompt = substituteVars(step.rawPrompt, vars);

        const fullPrompt = soulPrefix + prompt;
        if (soulPrefix) soulPrefix = ""; // only prepend to first step
        const ctxBefore = -1;
        const response = await sendWithRetry(runtime, fullPrompt, step.name, flags.verbose, budget, retryDelayMs);
        const ctxAfter = -1;
        const duration = Date.now() - start;

        if (response) {
          state.steps[step.name] = { status: "ok", duration: Math.round(duration / 100) / 10, ctxBefore, ctxAfter };
          writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${step.name}.md`), redactSecrets(response), "utf-8");
          // Generic output chaining + explicit aliases
          vars[step.name.toUpperCase().replace(/-/g, "_") + "_OUTPUT"] = response;
          if (step.name === "retrospective") vars.RETRO_CONTENT = response;

          // #515: parse CONTRADICT directives from step 15 and invalidate old memories
          if (step.name === "contradiction-and-graph") {
            const memDb = memory.getDatabase();
            if (memDb) {
              const contradictRe = /CONTRADICT\s+old_id=(\d+)/g;
              let cm: RegExpExecArray | null;
              while ((cm = contradictRe.exec(response)) !== null) {
                const oldId = parseInt(cm[1]!, 10);
                const { changes } = memDb.prepare("UPDATE extracted_memories SET valid_to = ? WHERE id = ? AND valid_to IS NULL AND classification < 3").run(Date.now(), oldId);
                if (changes > 0) logInfo(TAG, `[SLEEP] Invalidated memory #${oldId} (contradicted)`);
              }

              // #520: parse RELATION directives → entity_graph
              const relationRe = /RELATION\s+entity_a="([^"]+)"\s+entity_b="([^"]+)"\s+rel="([^"]+)"/g;
              let rm: RegExpExecArray | null;
              while ((rm = relationRe.exec(response)) !== null) {
                const [, a, b, rel] = rm;
                memDb.prepare(
                  `INSERT INTO entity_graph (entity_a, entity_b, relation, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(entity_a, entity_b, relation) DO UPDATE SET last_seen_at = ?`
                ).run(a, b, rel, Date.now(), Date.now(), Date.now());
              }

              // #529: age out stale event memories via decay (recall_count / age_days < threshold)
              const EVENT_MIN_AGE_DAYS = 7;
              const DECAY_THRESHOLD = 0.1; // below this score → expire
              const now = Date.now();
              const candidates = memDb.prepare(
                `SELECT id, recall_count, created_at FROM extracted_memories WHERE memory_type = 'event' AND valid_to IS NULL AND created_at < ?`
              ).all(now - EVENT_MIN_AGE_DAYS * 86400_000) as { id: number; recall_count: number; created_at: number }[];
              let agedCount = 0;
              for (const m of candidates) {
                const ageDays = (now - m.created_at) / 86400_000;
                const score = m.recall_count / ageDays;
                if (score < DECAY_THRESHOLD) {
                  memDb.prepare("UPDATE extracted_memories SET valid_to = ? WHERE id = ?").run(now, m.id);
                  agedCount++;
                }
              }
              if (agedCount > 0) logInfo(TAG, `[SLEEP] Aged out ${agedCount} faded event memories (score < ${DECAY_THRESHOLD})`);
            }
          }
        } else {
          state.steps[step.name] = { status: "failed", duration: Math.round(duration / 100) / 10, attempts: MAX_RETRIES, ctxBefore, ctxAfter };
          dreamySucceeded = false;
        }
        writeStateFile(statePath, state);

        // #895: emit terminal event for the standard prompt-driven step
        fireOnStep(opts.onStep, {
          name: step.name,
          filename: step.filename,
          index: stepIndex,
          total: totalSteps,
          phase: response ? "done" : "failed",
        });

        logInfo(TAG, `[SLEEP] ${response ? "✓" : "✗"} ${step.name} (${(duration / 1000).toFixed(1)}s, ${response?.length ?? 0} chars)`);

        // Backoff between steps: 10s → 30s → 60s on consecutive failures, reset on success
        if (response) { consecutiveFailures = 0; } else { consecutiveFailures++; }
        const isEssential = step.name.startsWith("04") || false;
        if (!isEssential) {
          const delayMs = backoffMs(consecutiveFailures);
          if (delayMs > 0) {
            logInfo(TAG, `[SLEEP] Waiting ${Math.round(delayMs / 1000)}s before next step`);
            await new Promise(r => setTimeout(r, delayMs));
          }
        }
      }
    } finally {
      clearTimeout(timeoutHandle);
      // Runtime lifecycle is caller-owned — no shutdown call from the library.
    }

    // Set final status
    if (state.status === "ongoing") {
      state.status = dreamySucceeded ? "completed" : "failed";
      writeStateFile(statePath, state);
    }

    // Advance extraction watermark — only when all steps succeeded
    if (dreamySucceeded) {
      try {
        const count = sleepData.advanceExtractionWatermarks();
        logInfo(TAG, `[SLEEP] Extraction watermark advanced for ${count} chat(s)`);
      } catch { /* non-fatal */ }
    } else {
      logWarn(TAG, "[SLEEP] Watermark NOT advanced — essential steps failed, messages preserved for catch-up");
    }

    // Write audit
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

    // Wired post-task: flush old messages (keep max 500, age out >7 days, garbage 12h)
    if (dreamySucceeded) {
      try {
        // Flush garbage-marked messages
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
        // Age out + cap
        const { agedOut, capped } = sleepData.flushOldMessages({ maxAgeDays: 7, maxCount: 500 });
        if (agedOut > 0) logInfo(TAG, `[SLEEP] Flushed ${agedOut} messages >7d`);
        if (capped > 0) logInfo(TAG, `[SLEEP] Flushed ${capped} messages (cap 500)`);
      } catch (err) { logWarn(TAG, `[WIRED] flush failed: ${err instanceof Error ? err.message : String(err)}`); }
    }

    emitProgress("done");
    logInfo(TAG, `[SLEEP] 🏁 ${okCount} ok, ${failCount} failed, ${skipCount} skipped | wired: ${formatWiredResults(wiredResults)} | ${totalDuration.toFixed(0)}s total`);

    // Record result in _meta (#447)
    if (failCount === 0) {
      metaSet(db, "sleep_last_success_ts", Date.now());
      metaSet(db, "sleep_consecutive_failures", 0);
    } else {
      const prev = metaGetInt(db, "sleep_consecutive_failures") ?? 0;
      metaSet(db, "sleep_consecutive_failures", prev + 1);
      metaSet(db, "sleep_last_fail_reason", `${failCount} step(s) failed`);
    }

    return { ok: failCount === 0, failCount };
  } finally {
    memory.close();
  }
}

// CLI entry + isDirectRun removed — the standalone entry point now lives in
// cli/abmind.ts as the `abmind sleep` subcommand. Library consumers call
// runSleepCycle(opts) directly with their own SleepRuntime.
