import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeDatabase } from "./memory-db.js";
import {
  inspectAttributionRepair,
  applyAttributionRepair,
} from "./extracted-memory-attribution-repair.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

function insertMemory(
  db: Db,
  overrides: { id?: number; user_id: string; content_en: string; classification?: number; semantic_revision?: number; recall_count?: number; relevance_score?: number; confidence?: number; integrity?: number },
): number {
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO extracted_memories
       (user_id, content_original, content_en, memory_type, source_timestamp, created_at,
        emotion_score, classification, semantic_revision, recall_count, relevance_score, confidence, integrity)
     VALUES (?, ?, ?, 'fact', ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
  );
  const result = info.run(
    overrides.user_id,
    overrides.content_en,
    overrides.content_en,
    now,
    now,
    overrides.classification ?? 1,
    overrides.semantic_revision ?? 1,
    overrides.recall_count ?? 0,
    overrides.relevance_score ?? 0,
    overrides.confidence ?? 3,
    overrides.integrity ?? 2,
  );
  return Number(result.lastInsertRowid);
}

function insertWatermark(db: Db, userId: string): void {
  db.prepare("INSERT OR REPLACE INTO extraction_watermarks (user_id, last_processed_timestamp) VALUES (?, ?)").run(userId, Date.now());
}

function insertPendingQuestion(db: Db, memoryA: number, memoryB: number): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO dream_questions
       (id, user_id, memory_a_id, memory_b_id, memory_a_revision, memory_b_revision,
        question, status, source_run_id, source_step, created_at, expires_at)
     VALUES (?, 'master', ?, ?, 1, 1, 'question?', 'pending', 'run', 'contradiction-and-graph', ?, ?)`,
  ).run(`q-${memoryA}-${memoryB}`, Math.min(memoryA, memoryB), Math.max(memoryA, memoryB), now, now + 86_400_000);
}

function insertEdge(db: Db, sourceMemoryId: number): void {
  db.prepare(
    "INSERT INTO entity_graph (user_id, entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at) VALUES ('master', 'alice', 'bob', 'friend_of', ?, ?, ?)",
  ).run(sourceMemoryId, Date.now(), Date.now());
}

describe("attribution repair", () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "abmind-repair-test-"));
    db = initializeDatabase(join(tmpDir, "memory.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dry-run reports only exactly selected rows, collisions, private rows and watermarks", () => {
    insertMemory(db, { id: 1, user_id: "legacy1", content_en: "owned by legacy1" });
    insertMemory(db, { id: 2, user_id: "legacy1", content_en: "same content", classification: 1 });
    insertMemory(db, { id: 3, user_id: "master", content_en: "same content", classification: 1 });
    insertMemory(db, { id: 4, user_id: "legacy1", content_en: "secret legacy", classification: 3 });
    insertMemory(db, { id: 5, user_id: "other-owner", content_en: "not selected" });
    insertWatermark(db, "legacy1");

    const plan = inspectAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [],
      privateRowDecisions: [],
    });

    expect(plan.rows.map((row) => row.id)).toEqual([1]);
    expect(plan.collisions).toEqual([{ sourceMemoryId: 2, targetMemoryId: 3, contentEn: "same content" }]);
    expect(plan.privateRows).toEqual([{ sourceMemoryId: 4, classification: 3, contentEnLength: "secret legacy".length }]);
    expect(plan.staleWatermarkUserIds).toEqual(["legacy1"]);
  });

  it("owner correction preserves id, content, semantic_revision and FTS; removes watermark", () => {
    const id = insertMemory(db, { user_id: "legacy1", content_en: "correct me", semantic_revision: 4 });
    insertWatermark(db, "legacy1");
    const before = db.prepare("SELECT content_en, semantic_revision FROM extracted_memories WHERE id = ?").get(id) as { content_en: string; semantic_revision: number };

    const plan = inspectAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [],
      privateRowDecisions: [],
    });
    const result = applyAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [],
      privateRowDecisions: [],
    }, plan);

    expect(result.corrected).toEqual([id]);
    const after = db.prepare("SELECT user_id, content_en, semantic_revision FROM extracted_memories WHERE id = ?").get(id) as { user_id: string; content_en: string; semantic_revision: number };
    expect(after.user_id).toBe("master");
    expect(after.content_en).toBe(before.content_en);
    expect(after.semantic_revision).toBe(before.semantic_revision);
    const fts = db.prepare("SELECT rowid FROM extracted_memories_fts WHERE rowid = ?").get(id);
    expect(fts).not.toBeUndefined();
    expect((db.prepare("SELECT COUNT(*) as c FROM extraction_watermarks WHERE user_id = 'legacy1'").get() as { c: number }).c).toBe(0);
  });

  it("refuses apply when a collision has no decision", () => {
    insertMemory(db, { id: 1, user_id: "legacy1", content_en: "dup" });
    insertMemory(db, { id: 2, user_id: "master", content_en: "dup" });
    const plan = inspectAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [],
      privateRowDecisions: [],
    });
    expect(() => applyAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [],
      privateRowDecisions: [],
    }, plan)).toThrow(/no per-row decision/);
    expect((db.prepare("SELECT COUNT(*) as c FROM extracted_memories").get() as { c: number }).c).toBe(2);
  });

  it("#1660 refuses a collision merge when either side is class 3 and reports the ids", () => {
    // Target is a class-3 row: merging would apply MAX(classification, ?) and
    // could mint a format-0 class-3 row without touching content_en.
    const source = insertMemory(db, { id: 1, user_id: "legacy1", content_en: "dup", classification: 1 });
    const target = insertMemory(db, { id: 2, user_id: "master", content_en: "dup", classification: 3 });

    const plan = inspectAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [{ sourceMemoryId: source, action: "merge" }],
      privateRowDecisions: [],
    });
    expect(plan.collisions).toEqual([{ sourceMemoryId: source, targetMemoryId: target, contentEn: "dup" }]);

    expect(() => applyAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [{ sourceMemoryId: source, action: "merge" }],
      privateRowDecisions: [],
    }, plan)).toThrow(/class 3/);

    // No row was mutated.
    const sourceRow = db.prepare("SELECT user_id FROM extracted_memories WHERE id = ?").get(source) as { user_id: string };
    expect(sourceRow.user_id).toBe("legacy1");
    const targetRow = db.prepare("SELECT user_id, classification FROM extracted_memories WHERE id = ?").get(target) as { user_id: string; classification: number };
    expect(targetRow.user_id).toBe("master");
    expect(targetRow.classification).toBe(3);
  });

  it("merge keeps the target, aggregates fields, redirects graph references and dismisses questions", () => {
    const source = insertMemory(db, { id: 1, user_id: "legacy1", content_en: "dup", recall_count: 5, relevance_score: 7, confidence: 8, integrity: 1, classification: 1 });
    const target = insertMemory(db, { id: 2, user_id: "master", content_en: "dup", recall_count: 3, relevance_score: 4, confidence: 6, integrity: 2, classification: 1 });
    insertEdge(db, source);
    insertPendingQuestion(db, source, 900);

    const plan = inspectAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [{ sourceMemoryId: source, action: "merge" }],
      privateRowDecisions: [],
    });
    const result = applyAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [{ sourceMemoryId: source, action: "merge" }],
      privateRowDecisions: [],
    }, plan);

    expect(result.merged).toEqual([source]);
    const merged = db.prepare("SELECT recall_count, relevance_score, confidence, integrity, classification FROM extracted_memories WHERE id = ?").get(target) as { recall_count: number; relevance_score: number; confidence: number; integrity: number; classification: number };
    expect(merged.recall_count).toBe(8);
    expect(merged.relevance_score).toBe(7);
    expect(merged.confidence).toBe(8);
    expect(merged.integrity).toBe(3);
    expect(merged.classification).toBe(1);
    expect((db.prepare("SELECT COUNT(*) as c FROM extracted_memories WHERE id = ?").get(source) as { c: number }).c).toBe(0);
    const edge = db.prepare("SELECT source_memory_id FROM entity_graph").get() as { source_memory_id: number };
    expect(edge.source_memory_id).toBe(target);
    const question = db.prepare("SELECT status FROM dream_questions").get() as { status: string };
    expect(question.status).toBe("dismissed");
  });

  it("drop-source deletes only the source row and clears its graph reference", () => {
    const source = insertMemory(db, { id: 1, user_id: "legacy1", content_en: "dup" });
    const target = insertMemory(db, { id: 2, user_id: "master", content_en: "dup" });
    insertEdge(db, source);

    const plan = inspectAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [{ sourceMemoryId: source, action: "drop-source" }],
      privateRowDecisions: [],
    });
    applyAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [{ sourceMemoryId: source, action: "drop-source" }],
      privateRowDecisions: [],
    }, plan);

    expect((db.prepare("SELECT COUNT(*) as c FROM extracted_memories WHERE id = ?").get(source) as { c: number }).c).toBe(0);
    const kept = db.prepare("SELECT user_id, content_en, recall_count FROM extracted_memories WHERE id = ?").get(target) as { user_id: string; content_en: string; recall_count: number };
    expect(kept.user_id).toBe("master");
    expect(kept.content_en).toBe("dup");
    expect(kept.recall_count).toBe(0);
    const edge = db.prepare("SELECT source_memory_id FROM entity_graph").get() as { source_memory_id: number | null };
    expect(edge.source_memory_id).toBeNull();
  });

  it("private rows require per-row decisions; leave keeps owner, relabel changes it, delete removes it", () => {
    const leaveId = insertMemory(db, { id: 1, user_id: "legacy1", content_en: "private leave", classification: 2 });
    const relabelId = insertMemory(db, { id: 2, user_id: "legacy1", content_en: "private relabel", classification: 2 });
    const deleteId = insertMemory(db, { id: 3, user_id: "legacy1", content_en: "private delete", classification: 3 });
    insertEdge(db, deleteId);

    const plan = inspectAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [],
      privateRowDecisions: [
        { sourceMemoryId: leaveId, action: "leave" },
        { sourceMemoryId: relabelId, action: "relabel" },
        { sourceMemoryId: deleteId, action: "delete" },
      ],
    });

    const missing = inspectAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [],
      privateRowDecisions: [{ sourceMemoryId: leaveId, action: "leave" }],
    });
    expect(() => applyAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [],
      privateRowDecisions: [{ sourceMemoryId: leaveId, action: "leave" }],
    }, missing)).toThrow(/no per-row decision/);

    const result = applyAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [],
      privateRowDecisions: [
        { sourceMemoryId: leaveId, action: "leave" },
        { sourceMemoryId: relabelId, action: "relabel" },
        { sourceMemoryId: deleteId, action: "delete" },
      ],
    }, plan);

    expect(result.privateLeft).toEqual([leaveId]);
    expect(result.privateRelabeled).toEqual([relabelId]);
    expect(result.dropped).toEqual([deleteId]);
    expect((db.prepare("SELECT user_id FROM extracted_memories WHERE id = ?").get(leaveId) as { user_id: string }).user_id).toBe("legacy1");
    expect((db.prepare("SELECT user_id FROM extracted_memories WHERE id = ?").get(relabelId) as { user_id: string }).user_id).toBe("master");
    expect((db.prepare("SELECT COUNT(*) as c FROM extracted_memories WHERE id = ?").get(deleteId) as { c: number }).c).toBe(0);
    const edge = db.prepare("SELECT source_memory_id FROM entity_graph").get() as { source_memory_id: number | null };
    expect(edge.source_memory_id).toBeNull();
  });

  it("rejects unknown, duplicate and stale decision ids and rolls back nothing", () => {
    insertMemory(db, { id: 1, user_id: "legacy1", content_en: "unique content" });
    const plan = inspectAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [],
      privateRowDecisions: [],
    });

    expect(() => applyAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [{ sourceMemoryId: 999, action: "merge" }],
      privateRowDecisions: [],
    }, plan)).toThrow(/unknown or non-collision/);

    expect((db.prepare("SELECT user_id FROM extracted_memories WHERE id = 1").get() as { user_id: string }).user_id).toBe("legacy1");
  });

  it("rejects duplicate collision decisions", () => {
    insertMemory(db, { id: 1, user_id: "legacy1", content_en: "dup" });
    insertMemory(db, { id: 2, user_id: "master", content_en: "dup" });
    const plan = inspectAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [],
      privateRowDecisions: [],
    });
    expect(plan.collisions.length).toBe(1);

    expect(() => applyAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [
        { sourceMemoryId: 1, action: "merge" },
        { sourceMemoryId: 1, action: "drop-source" },
      ],
      privateRowDecisions: [],
    }, plan)).toThrow(/duplicate collision decision/);

    expect((db.prepare("SELECT COUNT(*) as c FROM extracted_memories").get() as { c: number }).c).toBe(2);
  });

  it("rolls back the whole apply on a mid-transaction precondition failure", () => {
    const id = insertMemory(db, { id: 1, user_id: "legacy1", content_en: "will be corrected" });
    insertWatermark(db, "legacy1");
    insertMemory(db, { id: 2, user_id: "legacy1", content_en: "dup", classification: 3 });
    insertMemory(db, { id: 3, user_id: "master", content_en: "dup", classification: 3 });

    const plan = inspectAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [],
      privateRowDecisions: [{ sourceMemoryId: 2, action: "relabel" }],
    });
    expect(plan.privateRows.map((row) => row.sourceMemoryId)).toEqual([2]);

    // Private decision references id 2 as relabel, but collision detection runs
    // first in validateDecisions? Both are decided, so force failure by
    // changing the row set between inspection and apply: delete the private
    // row's target so verification of the collision set passes but the source
    // disappears.
    db.prepare("DELETE FROM extracted_memories WHERE id = 3").run();
    const stalePlan = inspectAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [],
      privateRowDecisions: [{ sourceMemoryId: 2, action: "relabel" }],
    });
    expect(stalePlan.privateRows.map((row) => row.sourceMemoryId)).toEqual([2]);
    // Now remove row 2's source directly, so the plan is stale vs state.
    db.prepare("DELETE FROM extracted_memories WHERE id = 2").run();

    expect(() => applyAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["legacy1"],
      collisionDecisions: [],
      privateRowDecisions: [{ sourceMemoryId: 2, action: "relabel" }],
    }, stalePlan)).toThrow(/vanished|changed since inspection/);

    // Nothing else was touched: row 1 keeps its owner, watermark remains.
    expect((db.prepare("SELECT user_id FROM extracted_memories WHERE id = ?").get(id) as { user_id: string }).user_id).toBe("legacy1");
    expect((db.prepare("SELECT COUNT(*) as c FROM extraction_watermarks WHERE user_id = 'legacy1'").get() as { c: number }).c).toBe(1);
  });

  it("rejects a target id that is also a source id", () => {
    insertMemory(db, { user_id: "master", content_en: "x" });
    expect(() => inspectAttributionRepair(db, {
      targetUserId: "master",
      sourceUserIds: ["master"],
      collisionDecisions: [],
      privateRowDecisions: [],
    })).toThrow(/target user id must not be among the source user ids/);
  });
});
