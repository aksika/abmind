/**
 * dream-question-store.test.ts — #1515 durable Dreamy clarification questions.
 *
 * Covers: schema rejection, canonical pair/revision mapping, race-safe active
 * uniqueness, global cap, two-user isolation, identical-key asked idempotency,
 * conflicting-key refusal, dismissal, evidence disappearance/invalidation/
 * revision resolution, resolution-before-expiry, terminal immutability, and
 * bounded 30-day pruning.
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { MEMORY_DB_SCHEMA_SQL, registerFunctions } from "./memory-db.js";
import {
  DreamQuestionStore,
  ACTIVE_QUESTION_GLOBAL_CAP,
} from "./dream-question-store.js";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  registerFunctions(db);
  db.exec(MEMORY_DB_SCHEMA_SQL);
  return db;
}

function seedEvidence(
  db: Database.Database,
  id: number,
  userId = "master",
  opts?: { validTo?: string | null; classification?: number; revision?: number },
): void {
  db.prepare(
    `INSERT INTO extracted_memories
       (id, user_id, content_original, content_en, memory_type, source_timestamp, created_at,
        valid_to, classification, semantic_revision)
     VALUES (?, ?, ?, ?, 'fact', ?, ?, ?, ?, ?)`,
  ).run(
    id, userId, `fact ${id}`, `fact ${id}`, Date.now(), Date.now(),
    opts?.validTo ?? null, opts?.classification ?? 1, opts?.revision ?? 1,
  );
}

function makeStore(db: Database.Database, nowFn: () => number, idGen: () => string): DreamQuestionStore {
  return new DreamQuestionStore(db, { now: nowFn, idGen });
}

describe("dream_questions schema", () => {
  it("rejects statuses outside the lifecycle", () => {
    const db = createDb();
    expect(() => db.prepare(
      `INSERT INTO dream_questions (id, user_id, memory_a_id, memory_b_id, memory_a_revision,
        memory_b_revision, question, status, source_run_id, source_step, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("x1", "u", 1, 2, 1, 1, "q?", "bogus", "r1", "contradiction-and-graph", 0, 86400000)).toThrow();
    db.close();
  });

  it("rejects inverted canonical pairs (memory_a_id < memory_b_id)", () => {
    const db = createDb();
    expect(() => db.prepare(
      `INSERT INTO dream_questions (id, user_id, memory_a_id, memory_b_id, memory_a_revision,
        memory_b_revision, question, status, source_run_id, source_step, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'contradiction-and-graph', ?, ?)`,
    ).run("x2", "u", 5, 2, 1, 1, "q?", "r1", 0, 86400000)).toThrow();
    db.close();
  });

  it("rejects pending rows carrying asked/delivery fields", () => {
    const db = createDb();
    expect(() => db.prepare(
      `INSERT INTO dream_questions (id, user_id, memory_a_id, memory_b_id, memory_a_revision,
        memory_b_revision, question, status, source_run_id, source_step, created_at, expires_at, delivery_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'contradiction-and-graph', ?, ?, ?)`,
    ).run("x3", "u", 1, 2, 1, 1, "q?", "r1", 0, 86400000, "k")).toThrow();
    db.close();
  });
});

describe("DreamQuestionStore insertCandidate", () => {
  let db: Database.Database;
  let now = 1_000_000_000_000;
  let seq = 0;
  let store: DreamQuestionStore;

  function freshStore(): DreamQuestionStore {
    db = createDb();
    now = 1_000_000_000_000;
    seq = 0;
    store = makeStore(db, () => now, () => `q-${++seq}`);
    return store;
  }

  it("creates exactly one pending row with canonical pair/revision mapping", () => {
    freshStore();
    seedEvidence(db, 10);
    seedEvidence(db, 20);
    const r = store.insertCandidate({
      userId: "master", memoryAId: 10, memoryBId: 20,
      memoryARevision: 1, memoryBRevision: 1,
      question: "Which city do you prefer?", sourceRunId: "run-1",
    });
    expect(r).toEqual({ accepted: true, id: "q-1" });
    const row = db.prepare("SELECT * FROM dream_questions WHERE id = 'q-1'").get() as Record<string, unknown>;
    expect(row.user_id).toBe("master");
    expect(row.memory_a_id).toBe(10);
    expect(row.memory_b_id).toBe(20);
    expect(row.memory_a_revision).toBe(1);
    expect(row.memory_b_revision).toBe(1);
    expect(row.status).toBe("pending");
    expect(row.source_step).toBe("contradiction-and-graph");
    expect(row.expires_at).toBe(now + 7 * 24 * 3600_000);
    expect(row.asked_at).toBeNull();
    db.close();
  });

  it("rejects an active canonical pair (both directions)", () => {
    freshStore();
    seedEvidence(db, 10);
    seedEvidence(db, 20);
    store.insertCandidate({ userId: "master", memoryAId: 10, memoryBId: 20, memoryARevision: 1, memoryBRevision: 1, question: "q?", sourceRunId: "r1" });
    const dup = store.insertCandidate({ userId: "master", memoryAId: 10, memoryBId: 20, memoryARevision: 1, memoryBRevision: 1, question: "q2?", sourceRunId: "r1" });
    expect(dup).toEqual({ accepted: false, reason: "active_pair" });
    expect(db.prepare("SELECT COUNT(*) AS c FROM dream_questions").get()).toEqual({ c: 1 });
    db.close();
  });

  it("rejects pairs asked or dismissed within seven days", () => {
    freshStore();
    seedEvidence(db, 10);
    seedEvidence(db, 20);
    const r = store.insertCandidate({ userId: "master", memoryAId: 10, memoryBId: 20, memoryARevision: 1, memoryBRevision: 1, question: "q?", sourceRunId: "r1" });
    expect(r.accepted).toBe(true);
    expect(store.markAsked("master", "q-1", "delivery-1")).toEqual({ status: "asked" });
    expect(store.dismiss("master", "q-1")).toEqual({ status: "dismissed" });
    now += 3 * 24 * 3600_000;
    const again = store.insertCandidate({ userId: "master", memoryAId: 10, memoryBId: 20, memoryARevision: 1, memoryBRevision: 1, question: "q2?", sourceRunId: "r2" });
    expect(again).toEqual({ accepted: false, reason: "recent_asked_or_dismissed" });
    now += 8 * 24 * 3600_000;
    const later = store.insertCandidate({ userId: "master", memoryAId: 10, memoryBId: 20, memoryARevision: 1, memoryBRevision: 1, question: "q3?", sourceRunId: "r3" });
    expect(later.accepted).toBe(true);
    db.close();
  });

  it("rejects at the global active cap", () => {
    freshStore();
    for (let i = 1; i <= ACTIVE_QUESTION_GLOBAL_CAP; i++) {
      seedEvidence(db, i * 100);
      seedEvidence(db, i * 100 + 1);
      const r = store.insertCandidate({ userId: "master", memoryAId: i * 100, memoryBId: i * 100 + 1, memoryARevision: 1, memoryBRevision: 1, question: `q${i}?`, sourceRunId: "r" });
      expect(r.accepted).toBe(true);
    }
    seedEvidence(db, 9990);
    seedEvidence(db, 9991);
    const over = store.insertCandidate({ userId: "master", memoryAId: 9990, memoryBId: 9991, memoryARevision: 1, memoryBRevision: 1, question: "overflow?", sourceRunId: "r" });
    expect(over).toEqual({ accepted: false, reason: "global_cap" });
    db.close();
  });

  it("enforces two-user isolation for reads and mutations", () => {
    freshStore();
    seedEvidence(db, 10, "master");
    seedEvidence(db, 20, "master");
    seedEvidence(db, 30, "other");
    seedEvidence(db, 40, "other");
    store.insertCandidate({ userId: "master", memoryAId: 10, memoryBId: 20, memoryARevision: 1, memoryBRevision: 1, question: "q?", sourceRunId: "r1" });
    store.insertCandidate({ userId: "other", memoryAId: 30, memoryBId: 40, memoryARevision: 1, memoryBRevision: 1, question: "other q?", sourceRunId: "r2" });

    expect(store.nextPending("master")?.id).toBe("q-1");
    expect(store.nextPending("other")?.id).toBe("q-2");
    expect(store.list("master").questions).toHaveLength(1);
    expect(store.list("master").questions[0]!.id).toBe("q-1");

    expect(store.markAsked("master", "q-2", "k")).toEqual({ status: "not_found" });
    expect(store.dismiss("master", "q-2")).toEqual({ status: "not_found" });
    const row = db.prepare("SELECT status FROM dream_questions WHERE id = 'q-2'").get() as { status: string };
    expect(row.status).toBe("pending");
    db.close();
  });

  it("enforces race-safe active uniqueness at the constraint level", () => {
    freshStore();
    seedEvidence(db, 10);
    seedEvidence(db, 20);
    const r1 = store.insertCandidate({ userId: "master", memoryAId: 10, memoryBId: 20, memoryARevision: 1, memoryBRevision: 1, question: "q?", sourceRunId: "r1" });
    expect(r1).toEqual({ accepted: true, id: "q-1" });
    // A racing peer writing the same active pair hits the partial unique
    // index — at most one active row per canonical pair, guaranteed by SQLite.
    expect(() => db.prepare(
      `INSERT INTO dream_questions (id, user_id, memory_a_id, memory_b_id, memory_a_revision,
        memory_b_revision, question, status, source_run_id, source_step, created_at, expires_at)
       VALUES (?, 'master', 10, 20, 1, 1, ?, 'pending', 'race', 'contradiction-and-graph', ?, ?)`,
    ).run("race-1", "race q?", now, now + 86400000)).toThrow(/UNIQUE constraint failed/);
    expect(db.prepare("SELECT COUNT(*) AS c FROM dream_questions").get()).toEqual({ c: 1 });
    db.close();
  });
});

describe("DreamQuestionStore markAsked / dismiss", () => {
  let db: Database.Database;
  let store: DreamQuestionStore;
  let now = 1_000_000_000_000;

  function setup(): void {
    db = createDb();
    now = 1_000_000_000_000;
    store = makeStore(db, () => now, () => "q-fixed");
    seedEvidence(db, 10);
    seedEvidence(db, 20);
    store.insertCandidate({ userId: "master", memoryAId: 10, memoryBId: 20, memoryARevision: 1, memoryBRevision: 1, question: "q?", sourceRunId: "r1" });
  }

  it("marks asked with identical delivery key idempotently", () => {
    setup();
    expect(store.markAsked("master", "q-fixed", "delivery-1")).toEqual({ status: "asked" });
    expect(store.markAsked("master", "q-fixed", "delivery-1")).toEqual({ status: "asked" });
    const row = db.prepare("SELECT status, asked_at, delivery_key FROM dream_questions WHERE id = 'q-fixed'").get() as { status: string; asked_at: number; delivery_key: string };
    expect(row.status).toBe("asked");
    expect(row.asked_at).toBe(now);
    expect(row.delivery_key).toBe("delivery-1");
    db.close();
  });

  it("refuses a conflicting delivery key", () => {
    setup();
    expect(store.markAsked("master", "q-fixed", "delivery-1")).toEqual({ status: "asked" });
    expect(store.markAsked("master", "q-fixed", "delivery-2")).toEqual({ status: "conflict" });
    const row = db.prepare("SELECT delivery_key FROM dream_questions WHERE id = 'q-fixed'").get() as { delivery_key: string };
    expect(row.delivery_key).toBe("delivery-1");
    db.close();
  });

  it("returns not_found for unknown ids and owner mismatch", () => {
    setup();
    expect(store.markAsked("master", "nope", "k")).toEqual({ status: "not_found" });
    expect(store.dismiss("other-user", "q-fixed")).toEqual({ status: "not_found" });
    const row = db.prepare("SELECT status FROM dream_questions WHERE id = 'q-fixed'").get() as { status: string };
    expect(row.status).toBe("pending");
    db.close();
  });

  it("dismisses pending and asked rows, preserves asked fields, and is terminal", () => {
    setup();
    expect(store.dismiss("master", "q-fixed")).toEqual({ status: "dismissed" });
    expect(store.dismiss("master", "q-fixed")).toEqual({ status: "already_terminal" });
    const row = db.prepare("SELECT status, dismissed_at FROM dream_questions WHERE id = 'q-fixed'").get() as { status: string; dismissed_at: number };
    expect(row.status).toBe("dismissed");
    expect(row.dismissed_at).toBe(now);

    // asked -> dismissed preserves delivery fields
    setup();
    store.markAsked("master", "q-fixed", "delivery-1");
    expect(store.dismiss("master", "q-fixed")).toEqual({ status: "dismissed" });
    const askedRow = db.prepare("SELECT status, asked_at, delivery_key, dismissed_at FROM dream_questions WHERE id = 'q-fixed'").get() as { status: string; asked_at: number; delivery_key: string; dismissed_at: number };
    expect(askedRow.status).toBe("dismissed");
    expect(askedRow.asked_at).toBe(now);
    expect(askedRow.delivery_key).toBe("delivery-1");
    expect(askedRow.dismissed_at).toBe(now);
    db.close();
  });
});

describe("DreamQuestionStore reconciliation", () => {
  let db: Database.Database;
  let store: DreamQuestionStore;
  let now = 1_000_000_000_000;
  let seq = 0;

  function setup(): void {
    db = createDb();
    now = 1_000_000_000_000;
    seq = 0;
    store = makeStore(db, () => now, () => `q-list-${++seq}`);
  }

  function addCandidate(a: number, b: number, revisionA = 1, revisionB = 1): string {
    store.insertCandidate({ userId: "master", memoryAId: a, memoryBId: b, memoryARevision: revisionA, memoryBRevision: revisionB, question: "q?", sourceRunId: "r1" });
    const row = db.prepare("SELECT id FROM dream_questions WHERE memory_a_id = ? AND memory_b_id = ?").get(a, b) as { id: string };
    return row.id;
  }

  it("resolves when evidence disappears", () => {
    setup();
    seedEvidence(db, 10);
    seedEvidence(db, 20);
    const id = addCandidate(10, 20);
    db.prepare("DELETE FROM extracted_memories WHERE id = 10").run();
    expect(store.nextPending("master")).toBeNull();
    const row = db.prepare("SELECT status, resolved_at FROM dream_questions WHERE id = ?").get(id) as { status: string; resolved_at: number };
    expect(row.status).toBe("resolved");
    expect(row.resolved_at).toBe(now);
    db.close();
  });

  it("resolves when evidence is invalidated (valid_to set)", () => {
    setup();
    seedEvidence(db, 10);
    seedEvidence(db, 20);
    const id = addCandidate(10, 20);
    db.prepare("UPDATE extracted_memories SET valid_to = '2026-08-01' WHERE id = 20").run();
    store.nextPending("master");
    const row = db.prepare("SELECT status FROM dream_questions WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("resolved");
    db.close();
  });

  it("resolves when semantic revision changes", () => {
    setup();
    seedEvidence(db, 10);
    seedEvidence(db, 20);
    const id = addCandidate(10, 20, 1, 1);
    db.prepare("UPDATE extracted_memories SET semantic_revision = 2 WHERE id = 10").run();
    store.nextPending("master");
    const row = db.prepare("SELECT status FROM dream_questions WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("resolved");
    db.close();
  });

  it("resolves when classification is no longer below 3", () => {
    setup();
    seedEvidence(db, 10, "master", { classification: 1 });
    seedEvidence(db, 20);
    const id = addCandidate(10, 20);
    db.prepare("UPDATE extracted_memories SET classification = 4 WHERE id = 20").run();
    store.nextPending("master");
    const row = db.prepare("SELECT status FROM dream_questions WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("resolved");
    db.close();
  });

  it("resolves when evidence owner changes", () => {
    setup();
    seedEvidence(db, 10, "master");
    seedEvidence(db, 20, "master");
    const id = addCandidate(10, 20);
    db.prepare("UPDATE extracted_memories SET user_id = 'intruder' WHERE id = 20").run();
    store.nextPending("master");
    const row = db.prepare("SELECT status FROM dream_questions WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("resolved");
    db.close();
  });

  it("prefers resolved over expired (resolution-before-expiry)", () => {
    setup();
    seedEvidence(db, 10);
    seedEvidence(db, 20);
    const id = addCandidate(10, 20);
    now += 8 * 24 * 3600_000;
    db.prepare("DELETE FROM extracted_memories WHERE id = 10").run();
    store.nextPending("master");
    const row = db.prepare("SELECT status, resolved_at FROM dream_questions WHERE id = ?").get(id) as { status: string; resolved_at: number };
    expect(row.status).toBe("resolved");
    expect(row.resolved_at).toBe(now);
    db.close();
  });

  it("expires active rows after seven days when evidence survives", () => {
    setup();
    seedEvidence(db, 10);
    seedEvidence(db, 20);
    const id = addCandidate(10, 20);
    now += 8 * 24 * 3600_000;
    expect(store.nextPending("master")).toBeNull();
    const row = db.prepare("SELECT status FROM dream_questions WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("expired");
    db.close();
  });

  it("keeps terminal rows immutable", () => {
    setup();
    seedEvidence(db, 10);
    seedEvidence(db, 20);
    const id = addCandidate(10, 20);
    db.prepare("DELETE FROM extracted_memories WHERE id = 10").run();
    store.nextPending("master");
    // Terminal (resolved) row must not flip again even if evidence returns.
    seedEvidence(db, 10);
    store.nextPending("master");
    const row = db.prepare("SELECT status FROM dream_questions WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("resolved");
    db.close();
  });

  it("prunes terminal rows older than 30 days", () => {
    setup();
    seedEvidence(db, 10);
    seedEvidence(db, 20);
    const id = addCandidate(10, 20);
    db.prepare("DELETE FROM extracted_memories WHERE id = 10").run();
    store.nextPending("master");
    now += 31 * 24 * 3600_000;
    store.nextPending("master");
    const row = db.prepare("SELECT id FROM dream_questions WHERE id = ?").get(id);
    expect(row).toBeUndefined();
    db.close();
  });

  it("list returns active rows with optional status filter and bounded limits", () => {
    setup();
    for (let i = 1; i <= 5; i++) {
      seedEvidence(db, i * 100);
      seedEvidence(db, i * 100 + 1);
      store.insertCandidate({ userId: "master", memoryAId: i * 100, memoryBId: i * 100 + 1, memoryARevision: 1, memoryBRevision: 1, question: `q${i}?`, sourceRunId: "r" });
    }
    const all = store.list("master");
    expect(all.questions).toHaveLength(5);
    const limited = store.list("master", undefined, 2);
    expect(limited.questions).toHaveLength(2);
    const capped = store.list("master", undefined, 999);
    expect(capped.questions).toHaveLength(5);
    const first = all.questions[0]!.id;
    store.markAsked("master", first, "k");
    const asked = store.list("master", "asked");
    expect(asked.questions).toHaveLength(1);
    expect(asked.questions[0]!.askedAt).toBeDefined();
    const pending = store.list("master", "pending");
    expect(pending.questions).toHaveLength(4);
    db.close();
  });
});
