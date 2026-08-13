/**
 * Test harness for sleep orchestrator integration tests (#175).
 *
 * Provides:
 * - Temp memory dir with initialized abmind DB
 * - MockRuntime implementing SleepRuntime with prompt-hint-keyed responses
 * - Deterministic time injection helpers
 * - Lock file pre-seeding for resume/catch-up scenarios
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "better-sqlite3";
import { MemoryManager, getMemoryDb } from "../memory-manager.js";
import { loadMemoryConfig, type MemoryConfig } from "../memory-config.js";
import type { SleepRuntime, SleepCompletionRequest } from "./contracts.js";

// ── Mock runtime ────────────────────────────────────────────────────────────

export interface MockRuntime extends SleepRuntime {
  setResponse(stepHint: string, response: string): void;
  setError(stepHint: string, err: Error): void;
  setDefault(response: string): void;
  callCount(): number;
  callsFor(stepHint: string): string[];
  allCalls(): Array<{ prompt: string; stepId: string; runId: string }>;
}

/** #1653: when the mock serves an extraction prompt it ALSO mirrors the model's
 *  `abmind store` side effect by creating real rows in the test memory DB —
 *  otherwise the deterministic review would flag a "no extraction writes"
 *  failure on every happy-path run. Rows use the harness's fixed clock so they
 *  land inside the review's run window. */
export function seedExtractedMemories(db: Database, atTs: number, count = 2): void {
  const stmt = db.prepare(
    `INSERT INTO extracted_memories (user_id, content_original, content_en, memory_type, source_timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < count; i++) {
    stmt.run("master", `seeded fact ${i}`, `seeded fact ${i}`, "fact", atTs, atTs);
  }
}

/** Create a SleepRuntime mock. complete() matches prompt against registered hints; first hint-match wins. */
export function createMockRuntime(opts?: { db?: Database | null; now?: () => number }): MockRuntime {
  const responses = new Map<string, string>();
  const errors = new Map<string, Error>();
  let defaultResponse = "(mock default)";
  const calls: Array<{ prompt: string; stepId: string; runId: string }> = [];

  return {
    async complete(request: SleepCompletionRequest): Promise<string> {
      const { prompt, stepId, runId } = request;
      calls.push({ prompt, stepId, runId });
      // Ensure writeStateFile flush ordering before returning (see plan Phase 2 atomicity note)
      await Promise.resolve();
      for (const [hint, err] of errors) {
        if (prompt.includes(hint)) throw err;
      }
      let response: string | undefined;
      for (const [hint, resp] of responses) {
        if (prompt.includes(hint)) { response = resp; break; }
      }
      const result = response ?? defaultResponse;
      // #1653: mirror the model's memory-store side effect for extraction
      // prompts (the real model executes abmind store tool calls).
      if (opts?.db && prompt.includes("store a memory using abmind store")) {
        seedExtractedMemories(opts.db, (opts.now?.() ?? Date.now()));
      }
      return result;
    },

    setResponse(stepHint, response) { responses.set(stepHint, response); },
    setError(stepHint, err) { errors.set(stepHint, err); },
    setDefault(response) { defaultResponse = response; },
    callCount() { return calls.length; },
    callsFor(stepHint) { return calls.filter(c => c.prompt.includes(stepHint)).map(c => c.prompt); },
    allCalls() { return [...calls]; },
  };
}

// ── Memory env setup ────────────────────────────────────────────────────────

export interface TestEnv {
  memoryDir: string;
  memory: MemoryManager;
  memoryConfig: MemoryConfig;
  sleepDir: string;
  dailyDir: string;
  runtime: MockRuntime;
  /** Fixed "today" timestamp — use in opts.now */
  now: number;
  todayStr: string;       // YYYYMMDD
  todayIso: string;       // YYYY-MM-DD
  cleanup: () => void;
}

export interface SetupOpts {
  seedMessages?: number;
  /** Fixed today as YYYY-MM-DD. Defaults to a stable test date. */
  today?: string;
  /** Seed today's lock file. Steps default to empty map. */
  preseedLock?: {
    status?: "ongoing" | "completed" | "suspended" | "failed";
    llmCalls?: number;
    steps?: Record<string, { status: "ok" | "failed" | "skipped" | "pending" | "timeout"; duration?: number; path?: string }>;
  };
  /** Seed a previous day's lock file for catch-up tests. */
  preseedPreviousDayLock?: {
    dateStr: string;      // YYYYMMDD
    steps: Record<string, { status: "ok" | "failed" | "skipped" | "pending" | "timeout" }>;
    ageDaysAtNow?: number;
  };
  /** Seed a daily_YYYY-MM-DD.md file (for resume scenarios that start mid-cycle). */
  preseedDailyFile?: { date: string; content: string };
}

export async function setupTestEnv(opts: SetupOpts = {}): Promise<TestEnv> {
  const memoryDir = mkdtempSync(join(tmpdir(), "sleep-orch-"));
  const todayIso = opts.today ?? "2026-04-18";
  const todayStr = todayIso.replace(/-/g, "");
  const now = new Date(`${todayIso}T12:00:00`).getTime();

  // Set up a fake ABMIND_HOME with prompts — loadSleepSteps() reads from here
  const abmindHomeDir = join(memoryDir, "abmind-home");
  mkdirSync(join(abmindHomeDir, "prompts", "sleep"), { recursive: true });
  // Copy prompt files from the abmind repo tree into the temp home.
  // We're inside abmind/src/sleep/, prompts live at abmind/templates/prompts/sleep/.
  const hereDir = dirname(fileURLToPath(import.meta.url));
  const promptsSrc = join(hereDir, "..", "..", "templates", "prompts", "sleep");
  if (existsSync(promptsSrc)) {
    for (const f of readdirSync(promptsSrc)) {
      if (f.endsWith(".md")) copyFileSync(join(promptsSrc, f), join(abmindHomeDir, "prompts", "sleep", f));
    }
  }
  process.env["ABMIND_HOME"] = abmindHomeDir;
  process.env["ABMIND_USER_ID"] = "master";

  // Init abmind
  const baseConfig = loadMemoryConfig();
  const memoryConfig: MemoryConfig = { ...baseConfig, memoryDir, memoryEnabled: true };
  const memory = new MemoryManager(memoryConfig);
  await memory.initialize({ skipEmbeddingCheck: true });

  const sleepDir = join(memoryDir, "sleep");
  const dailyDir = join(memoryDir, "daily");
  mkdirSync(sleepDir, { recursive: true });
  mkdirSync(dailyDir, { recursive: true });
  mkdirSync(join(memoryDir, "core"), { recursive: true });

  // Seed messages — direct SQL insert, bypass scanner for test determinism
  if (opts.seedMessages && opts.seedMessages > 0) {
    const db = getMemoryDb(memory);
    if (!db) throw new Error("test harness: DB not available after init");
    const stmt = db.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
    );
    const baseTs = now - opts.seedMessages * 60_000; // 1 msg/min backward
    for (let i = 0; i < opts.seedMessages; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      stmt.run("master", "master:telegram", role, `test message ${i}`, baseTs + i * 60_000);
    }
  }

  // Pre-seed today's lock file (use PID 99999 — unlikely to be alive,
  // so the orchestrator sees "stale lock" and resumes instead of "already running")
  if (opts.preseedLock) {
    const lockPath = join(sleepDir, `sleep_${todayStr}.lock`);
    writeFileSync(lockPath, JSON.stringify({
      status: opts.preseedLock.status ?? "ongoing",
      pid: 99999,
      startedAt: now - 60_000,
      llmCalls: opts.preseedLock.llmCalls ?? 0,
      steps: opts.preseedLock.steps ?? {},
    }, null, 2));
  }

  // Pre-seed previous day's lock file
  if (opts.preseedPreviousDayLock) {
    const prev = opts.preseedPreviousDayLock;
    const lockPath = join(sleepDir, `sleep_${prev.dateStr}.lock`);
    writeFileSync(lockPath, JSON.stringify({
      status: "failed",
      pid: 0,
      startedAt: now - (prev.ageDaysAtNow ?? 1) * 86400_000,
      llmCalls: 0,
      steps: prev.steps,
    }, null, 2));
  }

  // Pre-seed daily file (for resume scenarios)
  if (opts.preseedDailyFile) {
    const f = opts.preseedDailyFile;
    writeFileSync(join(dailyDir, `daily_${f.date}.md`), f.content);
  }

  const runtime = createMockRuntime({ db: getMemoryDb(memory), now: () => now });

  return {
    memoryDir, memory, memoryConfig, sleepDir, dailyDir, runtime, now, todayStr, todayIso,
    cleanup() { memory.close(); rmSync(memoryDir, { recursive: true, force: true }); },
  };
}
