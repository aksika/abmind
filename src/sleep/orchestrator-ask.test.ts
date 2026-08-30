/**
 * orchestrator-ask.test.ts — #1515 step-05 clarification-candidate gate.
 *
 * Unit coverage for parseAskLines / normalizeQuestion / processAskCandidates
 * plus orchestrator-level integration proving: no-op neutrality, valid
 * insertion, rejection classes, #1653 ordering, cancellation/skips, and
 * injected-store-failure neutrality for lock, report, watermark, resumability,
 * and message flushing.
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { runSleepCycle } from "./orchestrator.js";
import {
  parseAskLines,
  normalizeQuestion,
  processAskCandidates,
  type AskCandidateContext,
} from "./orchestrator.js";
import { setupTestEnv, type TestEnv } from "./test-harness.js";
import type { SleepRunOptions, SleepCompletionRequest } from "./contracts.js";
import { getMemoryDb } from "../memory-manager.js";
import { DreamQuestionStore } from "../dream-question-store.js";
import { MEMORY_DB_SCHEMA_SQL, registerFunctions } from "../memory-db.js";
import { readFileSync, existsSync } from "node:fs";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  registerFunctions(db);
  db.exec(MEMORY_DB_SCHEMA_SQL);
  return db;
}

function seedEvidence(
  db: Database.Database,
  id: number,
  content: string,
  userId = "master",
  opts?: { createdAt?: number; validTo?: string | null; classification?: number; revision?: number },
): void {
  db.prepare(
    `INSERT INTO extracted_memories
       (id, user_id, content_original, content_en, memory_type, source_timestamp, created_at,
        valid_to, classification, semantic_revision)
     VALUES (?, ?, ?, ?, 'fact', ?, ?, ?, ?, ?)`,
  ).run(
    id, userId, content, content, opts?.createdAt ?? 0, opts?.createdAt ?? 0,
    opts?.validTo ?? null, opts?.classification ?? 1, opts?.revision ?? 1,
  );
}

// ── Unit: parsing ───────────────────────────────────────────────────────────

describe("parseAskLines", () => {
  it("parses exact anchored lines and JSON-decodes the question token", () => {
    const lines = parseAskLines(
      "Some commentary.\n" +
      "ASK old_id=10 new_id=20 question=\"Did you prefer the old or the new city?\"\n" +
      "ASK old_id=11 new_id=21 question=\"Which fact about the user is still true?\"\n" +
      "NO_QUESTIONS\n",
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ oldId: 10, newId: 20, question: "Did you prefer the old or the new city?" });
    expect(lines[1]).toEqual({ oldId: 11, newId: 21, question: "Which fact about the user is still true?" });
  });

  it("handles JSON-escaped quotes and unicode", () => {
    const lines = parseAskLines(`ASK old_id=1 new_id=2 question="She said \\"yes\\" — is that still true? ü"`);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.question).toBe('She said "yes" — is that still true? ü');
  });

  it("ignores malformed lines, prefix commentary, and non-JSON tokens", () => {
    const lines = parseAskLines(
      "- ASK old_id=1 new_id=2 question=\"x\"\n" +
      "ASK new_id=2 old_id=1 question=\"x\"\n" +
      "ASK old_id=1 new_id=2 question=not-json\n" +
      "ASK old_id=1 new_id=2\n" +
      "ASK old_id=1 new_id=2 question=\"a \"bad\" json\"\n" +
      "ASK old_id=1 new_id=2 question=42\n" +
      "ASK old_id=0 new_id=2 question=\"zero old id\"\n",
    );
    // Grammar-level lines parse; non-positive ids are rejected by the gate.
    // Every other candidate is malformed, prefixed, or non-JSON.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ oldId: 0, newId: 2, question: "zero old id" });
  });
});

describe("normalizeQuestion", () => {
  it("collapses CR/LF and repeated whitespace to one line", () => {
    expect(normalizeQuestion("Did  you   move?\r\nTell me.")).toBe("Did you move? Tell me.");
  });

  it("rejects too-short, too-long, and question-less text", () => {
    expect(normalizeQuestion("short?")).toBeNull();
    expect(normalizeQuestion("x".repeat(301))).toBeNull();
    expect(normalizeQuestion("No question mark here at all")).toBeNull();
  });

  it("accepts the 20-300 char window", () => {
    const ok = "A sufficiently long user-facing question with a question mark?";
    expect(ok.length).toBeGreaterThan(20);
    expect(normalizeQuestion(ok)).toBe(ok);
  });
});

// ── Unit: the deterministic gate ────────────────────────────────────────────

function makeContext(db: Database.Database, overrides?: Partial<AskCandidateContext>): AskCandidateContext {
  const newEvidenceRevisions = new Map([[20, 1], [21, 1]]);
  const existingEvidenceRevisions = new Map([[10, 1], [11, 1]]);
  const currentRunNewIds = new Set([20, 21]);
  seedEvidence(db, 10, "existing fact about the user", "master");
  seedEvidence(db, 11, "another existing fact", "master");
  seedEvidence(db, 20, "new fact about the user", "master", { createdAt: 1000 });
  seedEvidence(db, 21, "another new fact", "master", { createdAt: 1000 });
  return {
    response: "",
    questionStore: new DreamQuestionStore(db, { now: () => 1_000_000, idGen: () => `u-${Math.random().toString(36).slice(2)}` }),
    memDb: db,
    userId: "master",
    runId: "run-1",
    newEvidenceRevisions,
    existingEvidenceRevisions,
    currentRunNewIds,
    ...overrides,
  };
}

describe("processAskCandidates", () => {
  it("accepts a valid role-correct candidate with canonical pair/revision mapping", () => {
    const db = createDb();
    const ctx = makeContext(db, { response: 'ASK old_id=10 new_id=20 question="Did you prefer the old or the new city?"' });
    const accepted = processAskCandidates(ctx);
    expect(accepted).toBe(1);
    const row = db.prepare("SELECT * FROM dream_questions").get() as Record<string, unknown>;
    expect(row.status).toBe("pending");
    expect(row.memory_a_id).toBe(10);
    expect(row.memory_b_id).toBe(20);
    expect(row.memory_a_revision).toBe(1);
    expect(row.memory_b_revision).toBe(1);
    expect(row.user_id).toBe("master");
    db.close();
  });

  it("canonicalizes swapped role order after validating roles", () => {
    const swappedDb = createDb();
    // old_id=20, new_id=10 is a swapped-role line — must be rejected.
    const swapped = processAskCandidates(makeContext(swappedDb, { response: 'ASK old_id=20 new_id=10 question="Swapped roles should fail?"' }));
    expect(swapped).toBe(0);
    // Canonical pair: old=11 (>), new=20 — memory_a = min(11,20).
    const okDb = createDb();
    const ok = processAskCandidates(makeContext(okDb, { response: 'ASK old_id=11 new_id=20 question="Does the user prefer the older fact?"' }));
    expect(ok).toBe(1);
    const row = okDb.prepare("SELECT memory_a_id, memory_b_id, memory_a_revision FROM dream_questions").get() as Record<string, unknown>;
    expect(row.memory_a_id).toBe(11);
    expect(row.memory_b_id).toBe(20);
    expect(row.memory_a_revision).toBe(1);
    swappedDb.close();
    okDb.close();
  });

  it("rejects hallucinated ids and non-current-run new ids", () => {
    const db = createDb();
    seedEvidence(db, 22, "rendered but not current-run", "master", { createdAt: 1000 });
    const ctx = makeContext(db, {
      response: 'ASK old_id=10 new_id=22 question="New id outside the run window?"',
    });
    ctx.newEvidenceRevisions = new Map([[20, 1], [21, 1], [22, 1]]);
    ctx.currentRunNewIds = new Set([20, 21]);
    // old_id never rendered as existing evidence.
    expect(processAskCandidates({ ...ctx, response: 'ASK old_id=999 new_id=20 question="Hallucinated old id?"' })).toBe(0);
    // new_id never rendered as new evidence.
    expect(processAskCandidates({ ...ctx, response: 'ASK old_id=10 new_id=999 question="Hallucinated new id?"' })).toBe(0);
    // new_id rendered but not attributed to the current run.
    expect(processAskCandidates({ ...ctx, response: 'ASK old_id=10 new_id=22 question="New id outside the run window?"' })).toBe(0);
    db.close();
  });

  it("rejects cross-user, invalidated, and revision-changed evidence", () => {
    const db = createDb();
    seedEvidence(db, 30, "foreign fact", "other");
    seedEvidence(db, 31, "foreign fact 2", "other");
    const ctx = makeContext(db, {
      newEvidenceRevisions: new Map([[20, 1], [21, 1], [31, 1]]),
      existingEvidenceRevisions: new Map([[10, 1], [11, 1], [30, 1]]),
      currentRunNewIds: new Set([20, 21, 31]),
    });
    // Cross-user old row.
    expect(processAskCandidates({ ...ctx, response: 'ASK old_id=30 new_id=20 question="Cross user old row?"' })).toBe(0);
    // Invalidated new row (valid_to set).
    db.prepare("UPDATE extracted_memories SET valid_to = '2026-08-01' WHERE id = 21").run();
    expect(processAskCandidates({ ...ctx, response: 'ASK old_id=10 new_id=21 question="Invalidated new row?"' })).toBe(0);
    // Revision changed since snapshot.
    db.prepare("UPDATE extracted_memories SET semantic_revision = 2 WHERE id = 20").run();
    expect(processAskCandidates({ ...ctx, response: 'ASK old_id=10 new_id=20 question="Stale revision row?"' })).toBe(0);
    db.close();
  });

  it("rejects evidence whose classification is no longer below 3", () => {
    const db = createDb();
    const ctx = makeContext(db);
    db.prepare("UPDATE extracted_memories SET classification = 4 WHERE id = 20").run();
    expect(processAskCandidates({ ...ctx, response: 'ASK old_id=10 new_id=20 question="High classification row?"' })).toBe(0);
    db.close();
  });

  it("rejects secret-bearing questions", () => {
    const db = createDb();
    const ctx = makeContext(db, { response: 'ASK old_id=10 new_id=20 question="Is my sk-abcdefghijklmnopqrstuvwxyz123456 still valid?"' });
    expect(processAskCandidates(ctx)).toBe(0);
    db.close();
  });

  it("caps accepted candidates at three per run, evaluated in response order", () => {
    const db = createDb();
    // Four distinct valid pairs: existing ids 10-13 + new ids 20-23.
    seedEvidence(db, 10, "first existing fact", "master");
    seedEvidence(db, 11, "second existing fact", "master");
    seedEvidence(db, 12, "third existing fact", "master");
    seedEvidence(db, 13, "fourth existing fact", "master");
    seedEvidence(db, 20, "first new fact", "master", { createdAt: 1000 });
    seedEvidence(db, 21, "second new fact", "master", { createdAt: 1000 });
    seedEvidence(db, 22, "third new fact", "master", { createdAt: 1000 });
    seedEvidence(db, 23, "fourth new fact", "master", { createdAt: 1000 });
    const ctx: AskCandidateContext = {
      response: [
        'ASK old_id=10 new_id=20 question="First clarification question?"',
        'ASK old_id=11 new_id=21 question="Second clarification question?"',
        'ASK old_id=12 new_id=22 question="Third clarification question?"',
        'ASK old_id=13 new_id=23 question="Fourth clarification question?"',
      ].join("\n"),
      questionStore: new DreamQuestionStore(db, { now: () => 1_000_000, idGen: () => `u-${Math.random().toString(36).slice(2)}` }),
      memDb: db,
      userId: "master",
      runId: "run-1",
      newEvidenceRevisions: new Map([[20, 1], [21, 1], [22, 1], [23, 1]]),
      existingEvidenceRevisions: new Map([[10, 1], [11, 1], [12, 1], [13, 1]]),
      currentRunNewIds: new Set([20, 21, 22, 23]),
    };
    expect(processAskCandidates(ctx)).toBe(3);
    expect(db.prepare("SELECT COUNT(*) AS c FROM dream_questions").get()).toEqual({ c: 3 });
    db.close();
  });

  it("drops duplicate canonical pairs through the store dedupe", () => {
    const db = createDb();
    const ctx = makeContext(db, {
      response: [
        'ASK old_id=10 new_id=20 question="First clarification question?"',
        'ASK old_id=20 new_id=10 question="Reverse order duplicate?"',
      ].join("\n"),
    });
    expect(processAskCandidates(ctx)).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS c FROM dream_questions").get()).toEqual({ c: 1 });
    db.close();
  });
});

// ── Integration: orchestrator end-to-end ────────────────────────────────────

function baseOpts(env: TestEnv, overrides: Partial<SleepRunOptions> = {}): SleepRunOptions {
  return {
    runtime: env.runtime,
    now: () => env.now,
    timeoutMs: 60_000,
    fresh: false,
    betweenStepBackoffMs: () => 0,
    memoryConfigOverride: { memoryDir: env.memoryDir, memoryEnabled: true },
    ...overrides,
  };
}

function defaultCannedResponses(env: TestEnv): void {
  env.runtime.setDefault("ok");
  env.runtime.setResponse("Update the summary incorporating", "- user asked about X\n- decision Y made\n- a second durable fact worth remembering across sessions");
  env.runtime.setResponse("store a memory using abmind store", "2 memories stored");
  env.runtime.setResponse("retrospective", "Today went well. Flagged nothing.");
}

/** Seed one EXISTING (yesterday) memory that FTS-matches the run-time new
 *  extractions via the distinctive "flummox" keyword. */
function seedExistingMemory(env: TestEnv, id: number): void {
  const db = getMemoryDb(env.memory)!;
  const yesterday = env.now - 86_400_000;
  db.prepare(
    `INSERT INTO extracted_memories
       (id, user_id, content_original, content_en, memory_type, source_timestamp, created_at,
        valid_to, classification, semantic_revision)
     VALUES (?, 'master', ?, ?, 'fact', ?, ?, NULL, 1, 1)`,
  ).run(id, "flummox seed fact 99", "flummox seed fact 99", yesterday, yesterday);
}

/** Mirror the model's extraction side effect at run time with EXPLICIT ids so
 *  ASK lines can name them deterministically. */
function seedRunTimeExtractions(env: TestEnv, ids: number[]): void {
  const origComplete = env.runtime.complete.bind(env.runtime);
  env.runtime.complete = async (request: SleepCompletionRequest) => {
    if (request.prompt.includes("store a memory using abmind store")) {
      const db = getMemoryDb(env.memory)!;
      for (const id of ids) {
        db.prepare(
          `INSERT INTO extracted_memories
             (id, user_id, content_original, content_en, memory_type, source_timestamp, created_at)
           VALUES (?, 'master', ?, ?, 'fact', ?, ?)`,
        ).run(id, `flummox contradiction event ${id}`, `flummox contradiction event ${id}`, env.now, env.now);
      }
      return "2 memories stored";
    }
    return origComplete(request);
  };
}

function askResponse(lines: string[]): string {
  return "Some commentary.\n" + lines.join("\n") + "\nNO_QUESTIONS\n";
}

function countQuestions(env: TestEnv): number {
  const db = getMemoryDb(env.memory)!;
  const row = db.prepare("SELECT COUNT(*) AS c FROM dream_questions").get() as { c: number };
  return row.c;
}

function readLock(env: TestEnv): { status: string; steps: Record<string, { status: string }> } | null {
  const p = join(env.sleepDir, `sleep_${env.todayStr}.lock`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

function readWatermarkAny(env: TestEnv): number {
  const db = getMemoryDb(env.memory)!;
  const row = db.prepare("SELECT last_processed_timestamp FROM extraction_watermarks ORDER BY last_processed_timestamp DESC LIMIT 1").get() as { last_processed_timestamp: number } | undefined;
  return row?.last_processed_timestamp ?? 0;
}

describe("#1515 orchestrator integration", () => {
  it("a valid ASK candidate creates exactly one pending row and the run completes", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    seedExistingMemory(env, 1001);
    seedRunTimeExtractions(env, [2001, 2002]);
    env.runtime.setResponse("Clarification Questions",
      askResponse(['ASK old_id=1001 new_id=2001 question="Did you prefer the older or the newer living arrangement?"']));
    try {
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("completed");
      expect(result.watermarkAdvanced).toBe(true);
      expect(countQuestions(env)).toBe(1);
      const db = getMemoryDb(env.memory)!;
      const row = db.prepare("SELECT * FROM dream_questions").get() as Record<string, unknown>;
      expect(row.memory_a_id).toBe(1001);
      expect(row.memory_b_id).toBe(2001);
      expect(row.status).toBe("pending");
      expect(row.question).toBe("Did you prefer the older or the newer living arrangement?");
      expect(row.user_id).toBe("master");
      expect(row.source_run_id).toBe(result.runId);
    } finally { env.cleanup(); }
  });

  it("no ASK output is a strict no-op — no rows, unchanged status/report/watermark", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    seedExistingMemory(env, 1001);
    seedRunTimeExtractions(env, [2001, 2002]);
    env.runtime.setResponse("Clarification Questions", "NO_CONTRADICTIONS\nNO_RELATIONS\nNO_QUESTIONS\n");
    const watermarkBefore = readWatermarkAny(env);
    try {
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("completed");
      expect(result.watermarkAdvanced).toBe(true);
      expect(countQuestions(env)).toBe(0);
      expect(result.report).not.toContain("question");
      expect(readWatermarkAny(env)).toBeGreaterThanOrEqual(watermarkBefore);
    } finally { env.cleanup(); }
  });

  it("rejects hallucinated, swapped-role, and malformed candidates without affecting the run", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    seedExistingMemory(env, 1001);
    seedRunTimeExtractions(env, [2001, 2002]);
    env.runtime.setResponse("Clarification Questions", askResponse([
      'ASK old_id=999 new_id=2001 question="Hallucinated existing id?"',
      'ASK old_id=2001 new_id=1001 question="Swapped roles?"',
      'ASK old_id=1001 new_id=777 question="Hallucinated new id?"',
      'ASK old_id=1001 new_id=2001 question=not-json',
    ]));
    try {
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("completed");
      expect(countQuestions(env)).toBe(0);
    } finally { env.cleanup(); }
  });

  it("an existing CONTRADICT invalidation prevents the same pair's question", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    seedExistingMemory(env, 1001);
    seedRunTimeExtractions(env, [2001, 2002]);
    env.runtime.setResponse("Clarification Questions", askResponse([
      'CONTRADICT old_id=1001 reason="Contradicted at store time"',
      'ASK old_id=1001 new_id=2001 question="Should never reach the store after invalidation?"',
    ]));
    try {
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("completed");
      expect(countQuestions(env)).toBe(0);
      const db = getMemoryDb(env.memory)!;
      const row = db.prepare("SELECT valid_to FROM extracted_memories WHERE id = 1001").get() as { valid_to: string | null };
      expect(row.valid_to).not.toBeNull();
    } finally { env.cleanup(); }
  });

  it("secret-bearing and over-cap candidates are bounded", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    seedExistingMemory(env, 1001);
    seedExistingMemory(env, 1002);
    seedExistingMemory(env, 1003);
    seedExistingMemory(env, 1004);
    seedRunTimeExtractions(env, [2001, 2002]);
    const db = getMemoryDb(env.memory)!;
    // Two more run-time pairs for the cap test.
    db.prepare(
      `INSERT INTO extracted_memories (id, user_id, content_original, content_en, memory_type, source_timestamp, created_at)
       VALUES (2003, 'master', 'flummox cap event three', 'flummox cap event three', 'fact', ?, ?),
              (2004, 'master', 'flummox cap event four', 'flummox cap event four', 'fact', ?, ?)`,
    ).run(env.now, env.now, env.now, env.now);
    env.runtime.setResponse("Clarification Questions", askResponse([
      'ASK old_id=1001 new_id=2001 question="Is my ghp_abcdefghijklmnopqrstuvwxyz1234567890 token still secret?"',
      'ASK old_id=1001 new_id=2001 question="First valid clarification question?"',
      'ASK old_id=1002 new_id=2002 question="Second valid clarification question?"',
      'ASK old_id=1003 new_id=2003 question="Third valid clarification question?"',
      'ASK old_id=1004 new_id=2004 question="Fourth valid clarification question?"',
    ]));
    try {
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("completed");
      expect(countQuestions(env)).toBe(3);
    } finally { env.cleanup(); }
  });

  it("skipped step 05 (no new extractions) creates no question", async () => {
    // Resume scenario: daily-summary + extract-memories already ok, so no
    // run-time extraction rows exist — step 05 finds no new evidence and is
    // skipped, and the question block must not fire.
    const env = await setupTestEnv({
      seedMessages: 3,
      preseedLock: {
        status: "ongoing",
        steps: {
          "daily-summary": { status: "ok" },
          "extract-memories": { status: "ok" },
        },
      },
    });
    defaultCannedResponses(env);
    seedExistingMemory(env, 1001);
    env.runtime.setResponse("Clarification Questions",
      askResponse(['ASK old_id=1001 new_id=2 question="Should never persist without evidence?"']));
    try {
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("completed");
      expect(countQuestions(env)).toBe(0);
      const lock = readLock(env);
      expect(lock!.steps["contradiction-and-graph"]?.status).toBe("skipped");
    } finally { env.cleanup(); }
  });

  it("a terminal step-05 model failure creates no question and stops the run", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    seedExistingMemory(env, 1001);
    seedRunTimeExtractions(env, [2001, 2002]);
    env.runtime.setError("Clarification Questions", new Error("provider down"));
    try {
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("failed");
      expect(result.report).toContain("contradiction-and-graph");
      expect(countQuestions(env)).toBe(0);
      const lock = readLock(env);
      expect(lock!.steps["contradiction-and-graph"]?.status).toBe("failed");
    } finally { env.cleanup(); }
  });

  it("a later terminal model failure suppresses questions from an otherwise-ok step 05", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    seedExistingMemory(env, 1001);
    seedRunTimeExtractions(env, [2001, 2002]);
    env.runtime.setResponse("Clarification Questions",
      askResponse(['ASK old_id=1001 new_id=2001 question="Must not survive a later terminal failure?"']));
    // Step 06 runs after contradiction-and-graph in the normal level. The
    // run is therefore terminally failed only after the ASK output was made.
    env.runtime.setError("Post-Retro Derivation", new Error("provider down after step 05"));
    try {
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("failed");
      expect(result.report).toContain("retro-derive");
      expect(countQuestions(env)).toBe(0);
      const lock = readLock(env);
      expect(lock!.steps["contradiction-and-graph"]?.status).toBe("ok");
      expect(lock!.steps["retro-derive"]?.status).toBe("failed");
    } finally { env.cleanup(); }
  });

  it("injected store failure leaves settlement, watermark, and report unchanged", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    seedExistingMemory(env, 1001);
    seedRunTimeExtractions(env, [2001, 2002]);
    env.runtime.setResponse("Clarification Questions",
      askResponse(['ASK old_id=1001 new_id=2001 question="Valid question whose storage fails?"']));
    const db = getMemoryDb(env.memory)!;
    db.exec("DROP TABLE dream_questions");
    const watermarkBefore = readWatermarkAny(env);
    try {
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("completed");
      expect(result.watermarkAdvanced).toBe(true);
      expect(result.resumable).toBe(false);
      expect(result.report).not.toContain("question");
      expect(readWatermarkAny(env)).toBeGreaterThan(watermarkBefore);
      const lock = readLock(env);
      expect(lock!.status).toBe("completed");
      for (const name of ["daily-summary", "extract-memories", "contradiction-and-graph"]) {
        expect(lock!.steps[name]?.status).toBe("ok");
      }
    } finally { env.cleanup(); }
  });

  it("a failed non-essential step does not block an authorized question; run stays partial and resumable", async () => {
    // Budget exhaustion fails retro-derive (non-essential) AFTER step 05. The
    // question block runs after that settlement decision, must not rewrite
    // status/report/watermark, and must still land the authorized row.
    const originalBudget = process.env["SLEEP_MAX_LLM_CALLS"];
    process.env["SLEEP_MAX_LLM_CALLS"] = "5";
    const env = await setupTestEnv({ seedMessages: 5 });
    defaultCannedResponses(env);
    seedExistingMemory(env, 1001);
    seedRunTimeExtractions(env, [2001, 2002]);
    env.runtime.setResponse("Clarification Questions",
      askResponse(['ASK old_id=1001 new_id=2001 question="Question lands on a partial run?"']));
    try {
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("partial");
      expect(result.resumable).toBe(true);
      expect(result.essentialFailures).toHaveLength(0);
      expect(countQuestions(env)).toBe(1);
      const lock = readLock(env);
      expect(lock!.steps["contradiction-and-graph"]?.status).toBe("ok");
      const failedNonEssential = Object.entries(lock!.steps).filter(([, s]) => s.status === "failed").map(([k]) => k);
      expect(failedNonEssential.length).toBeGreaterThan(0);
    } finally {
      if (originalBudget === undefined) delete process.env["SLEEP_MAX_LLM_CALLS"];
      else process.env["SLEEP_MAX_LLM_CALLS"] = originalBudget;
      env.cleanup();
    }
  });

  it("a resumed run with step 05 already ok does not re-process retained output", async () => {
    const env = await setupTestEnv({
      seedMessages: 5,
      preseedLock: { status: "ongoing", steps: { "contradiction-and-graph": { status: "ok" } } },
    });
    defaultCannedResponses(env);
    seedExistingMemory(env, 1001);
    seedRunTimeExtractions(env, [2001, 2002]);
    env.runtime.setResponse("Clarification Questions",
      askResponse(['ASK old_id=1001 new_id=2001 question="Resume must not re-ask?"']));
    try {
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("completed");
      expect(countQuestions(env)).toBe(0);
    } finally { env.cleanup(); }
  });
});
