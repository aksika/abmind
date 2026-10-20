/**
 * sleep-new-model.test.ts — #1937 new-model-only sleep acceptance.
 *
 * Covers:
 * - A10: an unconverted dataset is refused before any sleep work, with the
 *   conversion-required reason.
 * - A4: step 05 without a serving recall projection skips with the
 *   projection reason instead of a misleading one.
 * - A3: after the D1 purge, no pre-existing question is served or blocks a
 *   new durable question on the same numeric pair.
 * - A8: the generated emotional-profile section is removed once, other
 *   user_profile.md content is byte-identical, and later runs never write it.
 * - A9: a full sleep run on a dataset without the legacy tables completes.
 */

import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MEMORY_DB_SCHEMA_SQL, registerFunctions } from "../memory-db.js";
import { setPersonalState } from "../personal-schema.js";
import {
  DreamQuestionStore,
} from "../dream-question-store.js";
import { runSleepCycle, SleepInitError } from "./orchestrator.js";
import { setupTestEnv, cannedQuietFencedResponses, type TestEnv } from "./test-harness.js";
import type { SleepRunOptions } from "./contracts.js";
import { getMemoryDb } from "../memory-manager.js";
import { buildRecallProjection } from "../recall-projection-build.js";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  registerFunctions(db);
  db.exec(MEMORY_DB_SCHEMA_SQL);
  return db;
}

function seedDurable(
  db: Database.Database,
  id: number,
  userId = "master",
  opts?: { revision?: number; createdAt?: number },
): void {
  const ts = opts?.createdAt ?? Date.now();
  db.prepare(
    `INSERT INTO long_term_memories
       (id, user_id, memory_type, content, authority, applicability_scope, provenance, evidence,
        classification, encrypted, sealed_format_version, valid_to, revision, semantic_revision,
        created_at, updated_at)
     VALUES (?, ?, 'fact', ?, 'inference', '{"scope":"general"}', '{}', '[]',
        1, 0, 0, NULL, ?, ?, ?, ?)`,
  ).run(id, userId, `durable fact ${id}`, opts?.revision ?? 1, opts?.revision ?? 1, ts, ts);
}

function baseOpts(env: TestEnv, overrides: Partial<SleepRunOptions> = {}): SleepRunOptions {
  return {
    runtime: env.runtime,
    now: () => env.now,
    timeoutMs: 55 * 60_000,
    fresh: false,
    betweenStepBackoffMs: () => 0,
    retryDelays: [0],
    memoryConfigOverride: { memoryDir: env.memoryDir, memoryEnabled: true },
    ...overrides,
  };
}

function defaultCannedResponses(env: TestEnv): void {
  env.runtime.setDefault("ok");
  env.runtime.setResponse("Update the summary incorporating", "- user asked about X\n- decision Y made\n- a second durable fact worth remembering across sessions");
  env.runtime.setResponse("store a memory using abmind store", "2 memories stored");
  cannedQuietFencedResponses(env.runtime);
  env.runtime.setResponse("Mark small talk", "[]");
}

describe("#1937 A10: unconverted datasets are refused before any sleep work", () => {
  it("a legacy dataset fails with the conversion-required reason", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    try {
      const db = getMemoryDb(env.memory)!;
      setPersonalState(db, "legacy", { reason: "conversion required: test legacy dataset" });
      defaultCannedResponses(env);
      await expect(runSleepCycle(baseOpts(env))).rejects.toThrow(/conversion required/);
    } finally { env.cleanup(); }
  });
});

describe("#1937 A4: step 05 without a serving projection skips as not-serving", () => {
  it("no projection generation means step 05 is skipped, never misleading", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    try {
      defaultCannedResponses(env);
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("completed");
      const { readFileSync, existsSync } = await import("node:fs");
      const lockPath = join(env.sleepDir, `sleep_${env.todayStr}.lock`);
      expect(existsSync(lockPath)).toBe(true);
      const lock = JSON.parse(readFileSync(lockPath, "utf-8")) as {
        steps: Record<string, { status: string }>;
      };
      expect(lock.steps["contradiction-and-graph"]?.status).toBe("skipped");
      const db = getMemoryDb(env.memory)!;
      expect((db.prepare("SELECT COUNT(*) AS c FROM dream_questions").get() as { c: number }).c).toBe(0);
    } finally { env.cleanup(); }
  });
});

describe("#1937 A5: step 05 stays tool-less and deleted directives change nothing", () => {
  it("a deleted directive in the step-05 turn is rejected; no graph or memory row changes", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    try {
      defaultCannedResponses(env);
      const db = getMemoryDb(env.memory)!;
      const yesterday = env.now - 86_400_000;
      db.prepare(
        `INSERT INTO long_term_memories
          (id, user_id, memory_type, content, authority, applicability_scope, provenance, evidence,
           classification, encrypted, sealed_format_version, valid_to, revision, semantic_revision,
           created_at, updated_at)
         VALUES (1001, 'master', 'fact', 'flummox seed fact 99', 'inference',
           '{"scope":"general"}', '{}', '[]', 1, 0, 0, NULL, 1, 1, ?, ?)`,
      ).run(yesterday, yesterday);
      expect(buildRecallProjection(db, "master", { verifiedBackup: true }).ok).toBe(true);
      const before = (db.prepare("SELECT COUNT(*) AS c FROM long_term_memories").get() as { c: number }).c;
      // #1939 stage 3: entity_graph is dropped; the new-model graph surface
      // is recall_graph_edges.
      const beforeGraph = (db.prepare("SELECT COUNT(*) AS c FROM recall_graph_edges").get() as { c: number }).c;
      env.runtime.setBuilder("Clarification Questions", () => {
        const ids = (db.prepare(
          "SELECT id FROM long_term_memories WHERE user_id = 'master' AND content LIKE 'seeded fact from src %' ORDER BY id",
        ).all() as Array<{ id: number }>).map((r) => r.id);
        return [
          `RELATION source=${ids[0] ?? 1001} entity_a="a" entity_b="b" rel="uses"`,
          `CONTRADICT old_id=1001 new_id=${ids[0] ?? 1001} reason="conflict"`,
          "NO_QUESTIONS",
        ].join("\n");
      });
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("completed");
      // Nothing was written by the deleted directives.
      expect((db.prepare("SELECT COUNT(*) AS c FROM recall_graph_edges").get() as { c: number }).c).toBe(beforeGraph);
      const stillCurrent = db.prepare("SELECT valid_to FROM long_term_memories WHERE id = 1001").get() as { valid_to: string | null };
      expect(stillCurrent.valid_to).toBeNull();
      // The deleted directives wrote nothing: only the extraction's own
      // durable stores are new.
      const { readReceipts } = await import("./receipts.js");
      const receipts = readReceipts(env.memoryDir, result.runId);
      const acceptedStores = receipts.filter((r) => r.step === "extract-memories" && r.op === "store" && r.disposition === "accepted").length;
      expect((db.prepare("SELECT COUNT(*) AS c FROM long_term_memories").get() as { c: number }).c).toBe(before + acceptedStores);
      // Receipts record the refusals for step-13 judgment.
      const rejected = receipts.filter((r) => r.step === "contradiction-and-graph" && r.disposition === "rejected");
      expect(rejected.length).toBe(2);
    } finally { env.cleanup(); }
  });
});

describe("#1937 A2: revision change, supersession, or suppression resolves questions", () => {
  it("a revision bump or supersession resolves the question; text never re-exposes", () => {
    const db = createDb();
    try {
      seedDurable(db, 10);
      seedDurable(db, 20);
      const store = new DreamQuestionStore(db, { now: () => 1_000_000, idGen: (() => { let n = 0; return () => `q-${++n}`; })() });
      store.insertCandidate({
        userId: "master", memoryAId: 10, memoryBId: 20,
        memoryARevision: 1, memoryBRevision: 1,
        question: "Did you prefer the older or the newer living arrangement?",
        sourceRunId: "run-1",
      });
      expect(store.nextPending("master")?.id).toBe("q-1");

      // A revision change on either durable resolves.
      db.prepare("UPDATE long_term_memories SET revision = 2, semantic_revision = 2 WHERE id = 20").run();
      expect(store.nextPending("master")).toBeNull();
      expect((db.prepare("SELECT status FROM dream_questions WHERE id = 'q-1'").get() as { status: string }).status).toBe("resolved");

      // A superseded durable resolves a fresh question too.
      const store2 = new DreamQuestionStore(db, { now: () => 2_000_000, idGen: (() => { let n = 100; return () => `q-${++n}`; })() });
      db.prepare("UPDATE long_term_memories SET revision = 2, semantic_revision = 2 WHERE id = 20").run();
      seedDurable(db, 30);
      store2.insertCandidate({
        userId: "master", memoryAId: 20, memoryBId: 30,
        memoryARevision: 2, memoryBRevision: 1,
        question: "Second durable question?",
        sourceRunId: "run-2",
      });
      expect(store2.nextPending("master")?.id).toBe("q-101");
      db.prepare("UPDATE long_term_memories SET superseded_by_id = 999 WHERE id = 20").run();
      expect(store2.nextPending("master")).toBeNull();
      expect((db.prepare("SELECT status FROM dream_questions WHERE id = 'q-101'").get() as { status: string }).status).toBe("resolved");
    } finally { db.close(); }
  });
});

describe("#1928 C8: step-04 proposals carry validated graph relations", () => {
  it("PROPOSE_STORE with entities/relations stores a source-bound graph in provenance", async () => {
    const db = createDb();
    try {
      setPersonalState(db, "ready", { reason: "c8 fixture" });
      const { emptySnapshot, applyProposals } = await import("./proposals.js");
      const { SleepDataAccess } = await import("../sleep-data-access.js");
      const msgId = Number(db.prepare(
        "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, 'user', ?, 1000)",
      ).run("master", "s1", "Alice knows Bob in Paris").lastInsertRowid);
      const sleepData = new SleepDataAccess(db, "master");
      const snapshot = emptySnapshot("run-c8", "extract-memories", "master", ["store", "decline"]);
      snapshot.sources.set(msgId, "Alice knows Bob in Paris");
      const applied = await applyProposals(
        { db, sleepData, memoryDir: "/tmp", snapshot, alreadyAccepted: new Map() },
        `PROPOSE_STORE srcmsg=${msgId} type=fact text="Alice knows Bob in Paris" entities="Alice;Bob" relations="Alice|knows|Bob"`,
      );
      expect(applied.receipts[0]?.disposition).toBe("accepted");
      const row = db.prepare(
        "SELECT provenance FROM long_term_memories WHERE user_id = 'master'",
      ).get() as { provenance: string } | undefined;
      expect(row).toBeTruthy();
      const prov = JSON.parse(row!.provenance) as { graph?: { entities: string[]; relations: Array<{ a: string; rel: string; b: string }> } };
      expect(prov.graph?.entities).toEqual(["Alice", "Bob"]);
      expect(prov.graph?.relations).toEqual([{ a: "Alice", rel: "knows", b: "Bob" }]);
      // Malformed graph never fails the store; the fact still lands without edges.
      const msg2 = Number(db.prepare(
        "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, 'user', ?, 1000)",
      ).run("master", "s1", "Carol works alone").lastInsertRowid);
      const snapshot2 = emptySnapshot("run-c8b", "extract-memories", "master", ["store", "decline"]);
      snapshot2.sources.set(msg2, "Carol works alone");
      const applied2 = await applyProposals(
        { db, sleepData, memoryDir: "/tmp", snapshot: snapshot2, alreadyAccepted: new Map() },
        `PROPOSE_STORE srcmsg=${msg2} type=fact text="Carol works alone" entities="ThisEntityNameIsWayTooLongToBeValidBecauseItExceedsSixtyFourCharactersLimitXXX" relations="bad-relation-without-pipes"`,
      );
      expect(applied2.receipts[0]?.disposition).toBe("accepted");
      const row2 = db.prepare(
        "SELECT provenance FROM long_term_memories WHERE content = 'Carol works alone'",
      ).get() as { provenance: string } | undefined;
      expect(row2).toBeTruthy();
      expect(JSON.parse(row2!.provenance) as Record<string, unknown>).not.toHaveProperty("graph");
    } finally { db.close(); }
  });
});

describe("#1937 A6: REM OBSERVE output settles durably", () => {
  it("an OBSERVE proposal stores a durable observation row", async () => {
    const db = createDb();
    try {
      setPersonalState(db, "ready", { reason: "a6 fixture" });
      const { emptySnapshot, applyProposals } = await import("./proposals.js");
      const { SleepDataAccess } = await import("../sleep-data-access.js");
      const sleepData = new SleepDataAccess(db, "master");
      const snapshot = emptySnapshot("run-a6", "rem-synthesis", "master", ["observe"]);
      const applied = await applyProposals(
        { db, sleepData, memoryDir: "/tmp", snapshot, alreadyAccepted: new Map() },
        'OBSERVE type=observation text="a genuinely non-obvious recurring pattern across sessions"',
      );
      expect(applied.receipts[0]?.disposition).toBe("accepted");
      const row = db.prepare(
        "SELECT memory_type, content FROM long_term_memories WHERE user_id = 'master'",
      ).get() as { memory_type: string; content: string } | undefined;
      expect(row?.memory_type).toBe("observation");
      expect(row?.content).toContain("non-obvious recurring pattern");
    } finally { db.close(); }
  });
});

describe("#1937 A8: emotional-profile section removal", () => {
  it("removes exactly the generated section and keeps every other byte, once", async () => {
    const env = await setupTestEnv({ seedMessages: 3 });
    try {
      const coreDir = join(env.memoryDir, "core");
      mkdirSync(coreDir, { recursive: true });
      const before = "# User Profile\n\n- Name: Test User\n\n\n- Spaced paragraph kept verbatim\n\n## Emotional Patterns (auto-generated)\n\n- **work**: 80% positive. Top: joy(5)\n- **health**: 60% positive. Top: hope(2)\n\n## Notes\n\n- keeps notes here\n\n\n- trailing spaced block\n";
      const expected = "# User Profile\n\n- Name: Test User\n\n\n- Spaced paragraph kept verbatim\n\n## Notes\n\n- keeps notes here\n\n\n- trailing spaced block\n";
      writeFileSync(join(coreDir, "user_profile.md"), before, "utf-8");
      defaultCannedResponses(env);
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("completed");
      const { readFileSync } = await import("node:fs");
      const after = readFileSync(join(coreDir, "user_profile.md"), "utf-8");
      expect(after).toBe(expected);
      // Second run never rewrites it (whatever its status — the first run
      // consumed the messages, so a no_work return is also valid).
      const second = await runSleepCycle(baseOpts(env, { fresh: true }));
      expect(["completed", "no_work"]).toContain(second.status);
      expect(readFileSync(join(coreDir, "user_profile.md"), "utf-8")).toBe(after);
    } finally { env.cleanup(); }
  });
});

describe("#1937 A9: full sleep run without the legacy tables", () => {
  it("pre-sleep, steps, settlement, maintenance, and snapshot complete with no legacy access", async () => {
    const env = await setupTestEnv({ seedMessages: 5 });
    try {
      defaultCannedResponses(env);
      const db = getMemoryDb(env.memory)!;
      const yesterday = env.now - 86_400_000;
      db.prepare(
        `INSERT INTO long_term_memories
          (id, user_id, memory_type, content, authority, applicability_scope, provenance, evidence,
           classification, encrypted, sealed_format_version, valid_to, revision, semantic_revision,
           created_at, updated_at)
         VALUES (1001, 'master', 'fact', 'flummox seed fact 99', 'inference',
           '{"scope":"general"}', '{}', '[]', 1, 0, 0, NULL, 1, 1, ?, ?)`,
      ).run(yesterday, yesterday);
      const built = buildRecallProjection(db, "master", { verifiedBackup: true });
      expect(built.ok).toBe(true);
      env.runtime.setBuilder("Clarification Questions", () => {
        const ids = (db.prepare(
          "SELECT id FROM long_term_memories WHERE user_id = 'master' AND content LIKE 'seeded fact from src %' ORDER BY id",
        ).all() as Array<{ id: number }>).map((r) => r.id);
        const newId = ids[0];
        if (newId === undefined) return "NO_QUESTIONS\n";
        return `ASK old_id=1001 new_id=${newId} question="Did you prefer the older or the newer living arrangement?"\nNO_QUESTIONS\n`;
      });

      // #1939 stage 3: the legacy tables are dropped from the fresh schema —
      // no teardown drops needed.

      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("completed");
      expect(result.watermarkAdvanced).toBe(true);
      const row = db.prepare("SELECT memory_a_id, memory_b_id, status FROM dream_questions").get() as
        | { memory_a_id: number; memory_b_id: number; status: string }
        | undefined;
      expect(row?.status).toBe("pending");
      expect(row?.memory_a_id).toBe(1001);
    } finally { env.cleanup(); }
  });
});
