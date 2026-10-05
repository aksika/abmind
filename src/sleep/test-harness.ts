/**
 * Test harness for sleep orchestrator integration tests (#175).
 *
 * Provides:
 * - Temp memory dir with initialized abmind DB
 * - MockRuntime implementing SleepRuntime with prompt-hint-keyed responses
 * - Deterministic time injection helpers
 * - Lock file pre-seeding for resume/receipt scenarios
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, copyFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "better-sqlite3";
import { MemoryManager, getMemoryDb } from "../memory-manager.js";
import { loadMemoryConfig, type MemoryConfig } from "../memory-config.js";
import type { SleepRuntime, SleepCompletionRequest } from "./contracts.js";
import { resetSleepManifestCache } from "./sleep-manifest.js";

// ── Mock runtime ────────────────────────────────────────────────────────────

export interface MockRuntime extends SleepRuntime {
  setResponse(stepHint: string, response: string): void;
  /** #1859: a dynamic response builder consulted after errors and before
   *  static responses — used when the reply must name ids that only exist
   *  once the run created them. */
  setBuilder(stepHint: string, build: (prompt: string) => string): void;
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

/** #1859: the model no longer calls `abmind store`; extraction is fenced to
 *  proposals, so a text-only double must return bounded PROPOSE_STORE lines
 *  for the offered source ids. Real abmind application creates the rows and
 *  the receipts, keeping the whole path production-real in tests. */
export function synthesizeExtractionProposals(prompt: string): string | null {  if (!prompt.includes("PROPOSAL-EXTRACTION-V1")) return null;
  const ids: number[] = [];
  const re = /\[src=(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const id = parseInt(m[1]!, 10);
    if (Number.isSafeInteger(id) && id >= 1) ids.push(id);
  }
  if (ids.length === 0) return null;
  return ids.slice(0, 6)
    .map(id => `PROPOSE_STORE srcmsg=${id} type=fact text="seeded fact from src ${id}"`)
    .join("\n");
}

/** #1912: contract-compliant quiet fixtures for the stepped happy path.
 *  Registers explicit no-op outputs for every fenced step plus a
 *  tool-capable retrospective (appends to the bound artifact, mirroring
 *  production file tools the text-only double cannot execute). Tests
 *  exercising real step behavior override individual hints AFTER calling
 *  this — same-hint statics overwrite, builders take precedence over
 *  statics, and errors take precedence over everything. */
export function cannedQuietFencedResponses(runtime: MockRuntime): void {
  runtime.setBuilder("Append the retrospective to", (prompt: string) => {
    const match = prompt.match(/Append the retrospective to `([^`]+)`/);
    if (match?.[1]) {
      try {
        appendFileSync(match[1], "\n## Retrospective\nQuiet fixture reflection: events, emotional observations, lessons, and recurring errors were reviewed with nothing material to record.\n", "utf-8");
      } catch { /* an unreadable artifact fails the step honestly */ }
    }
    return "Retrospective appended to the daily file.";
  });
  runtime.setResponse("Clarification Questions", "NO_CONTRADICTIONS\nNO_RELATIONS\nNO_QUESTIONS\n");
  runtime.setResponse("Post-Retro Derivation", "No promotions\nNo knowledge changes.");
  runtime.setResponse("Adjust relevance scores", "0 boosts and 0 demotes");
  runtime.setResponse("Three metadata tasks", "(none)\n(none)\n(none)\n0 tagged, 0 merged, 0 emotion contexts.");
  runtime.setResponse("Fix memories with translation", "No translation issues.");
  runtime.setResponse("Dream journal", "0 observations proposed.\nDream journal: nothing non-obvious surfaced.");
  runtime.setResponse("Review the past week's conversations", "no recommendations");
  // #1912: the final review finds no faults and proposes acceptance. Runs
  // with failed steps still settle by the code-owned ceiling (partial /
  // blocked), never by this advisory line.
  runtime.setResponse("Final Review and Repair", "No faults found in the supervised run.\nVERDICT: accepted reason=\"all steps completed with recorded evidence\"");
}

/** Create a SleepRuntime mock. complete() matches prompt against registered hints; first hint-match wins. */export function createMockRuntime(opts?: { db?: Database | null; now?: () => number }): MockRuntime {
  const responses = new Map<string, string>();
  const builders = new Map<string, (prompt: string) => string>();
  const errors = new Map<string, Error>();
  let defaultResponse = "(mock default)";
  const calls: Array<{ prompt: string; stepId: string; runId: string }> = [];

  return {
    // #1859: a text-only double has no tool route, so proposal-only turns
    // are trivially enforced — the capability is declared, not assumed.
    proposalOnlyCapable: true,
    async complete(request: SleepCompletionRequest): Promise<string> {
      const { prompt, stepId, runId } = request;
      calls.push({ prompt, stepId, runId });
      // Ensure writeStateFile flush ordering before returning (see plan Phase 2 atomicity note)
      await Promise.resolve();
      for (const [hint, err] of errors) {
        if (prompt.includes(hint)) throw err;
      }
      for (const [hint, build] of builders) {
        if (prompt.includes(hint)) return build(prompt);
      }
      let response: string | undefined;
      for (const [hint, resp] of responses) {
        if (prompt.includes(hint)) { response = resp; break; }
      }
      // An explicitly configured response for the extraction marker wins:
      // tests use that to exercise incomplete or declined extractions.
      if (response !== undefined) return response;
      const synthesized = synthesizeExtractionProposals(prompt);
      if (synthesized !== null) return synthesized;
      return defaultResponse;
    },

    setResponse(stepHint, response) { responses.set(stepHint, response); },
    setBuilder(stepHint, build) { builders.set(stepHint, build); },
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
  /** Seed a previous day's lock file (a retained receipt — never a dispatch trigger). */
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

  // Set up a fake ABMIND_HOME with prompts + config — loadSleepSteps() reads
  // prompts from here, and the sleep manifest (sleep.json) from config/.
  const abmindHomeDir = join(memoryDir, "abmind-home");
  mkdirSync(join(abmindHomeDir, "prompts", "sleep"), { recursive: true });
  mkdirSync(join(abmindHomeDir, "config"), { recursive: true });
  // Copy prompt files from the abmind repo tree into the temp home.
  // We're inside abmind/src/sleep/, prompts live at abmind/templates/prompts/sleep/.
  const hereDir = dirname(fileURLToPath(import.meta.url));
  const promptsSrc = join(hereDir, "..", "..", "templates", "prompts", "sleep");
  if (existsSync(promptsSrc)) {
    for (const f of readdirSync(promptsSrc)) {
      if (f.endsWith(".md")) copyFileSync(join(promptsSrc, f), join(abmindHomeDir, "prompts", "sleep", f));
    }
  }
  // Copy the shipped manifest so harness tests exercise the real 12-step policy.
  const manifestSrc = join(hereDir, "..", "..", "templates", "config", "sleep.json");
  if (existsSync(manifestSrc)) {
    copyFileSync(manifestSrc, join(abmindHomeDir, "config", "sleep.json"));
  }
  process.env["ABMIND_HOME"] = abmindHomeDir;
  process.env["ABMIND_USER_ID"] = "master";
  // The manifest is memoized per process; a new fake home must reload it.
  resetSleepManifestCache();

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
      pid: 99999,
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
