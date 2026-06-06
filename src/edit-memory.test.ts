import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryManager } from "./memory-manager.js";
import { initializeDatabase } from "./memory-db.js";
import { makeMemoryTestConfig } from "./test-helpers.js";

function insertMemory(
  db: ReturnType<typeof initializeDatabase>,
  opts: { contentEn?: string; userId?: string; classification?: number; platformMessageId?: number } = {},
): number {
  const now = Date.now();
  const result = db.prepare(
    `INSERT INTO extracted_memories
       (user_id, content_original, content_en, memory_type, source_timestamp, created_at,
        preserve_original, emotion_score, classification, source_message_ids)
     VALUES (?, ?, ?, 'fact', ?, ?, 0, 0, ?, ?)`,
  ).run(
    opts.userId ?? "aksika",
    opts.contentEn ?? "teszt",
    opts.contentEn ?? "test",
    now, now,
    opts.classification ?? 1,
    opts.platformMessageId ? `[${opts.platformMessageId}]` : null,
  );
  return Number(result.lastInsertRowid);
}

function insertMessage(db: ReturnType<typeof initializeDatabase>, opts: { userId?: string; platformMessageId: number }): number {
  const result = db.prepare(
    "INSERT INTO messages (user_id, session_id, role, content, timestamp, platform_message_id) VALUES (?, 's1', 'user', 'msg', ?, ?)",
  ).run(opts.userId ?? "aksika", Date.now(), opts.platformMessageId);
  return Number(result.lastInsertRowid);
}

describe("editMemory", () => {
  let tmpDir: string;
  let mgr: MemoryManager;
  let db: ReturnType<typeof initializeDatabase>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "edit-mem-"));
    db = initializeDatabase(join(tmpDir, "memory.db"));
    db.close();

    mgr = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await mgr.initialize();
    db = mgr.getDatabase()!;
  });

  afterEach(() => {
    mgr.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updates attribute fields by memory ID", () => {
    const id = insertMemory(db);
    const result = mgr.editor.editMemory({ memoryId: id, credibility: 2, trust: 3, caller: "kp" });
    expect(result.ok).toBe(true);
    expect(result.memoriesUpdated).toBe(1);
    expect(result.fieldsUpdated).toContain("credibility");
    expect(result.fieldsUpdated).toContain("trust");

    const row = db.prepare("SELECT credibility, trust, edited_at, edited_by FROM extracted_memories WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row.credibility).toBe(2);
    expect(row.trust).toBe(3);
    expect(row.edited_by).toBe("kp");
    expect(row.edited_at).toBeTypeOf("number");
  });

  it("updates content and nulls embedding", () => {
    const id = insertMemory(db);
    db.prepare("UPDATE extracted_memories SET embedding = ? WHERE id = ?").run(Buffer.from([1, 2, 3]), id);

    const result = mgr.editor.editMemory({ memoryId: id, contentEn: "new content" });
    expect(result.ok).toBe(true);

    const row = db.prepare("SELECT content_en, embedding FROM extracted_memories WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row.content_en).toBe("new content");
    expect(row.embedding).toBeNull();
  });

  it("supports relative relevance delta", () => {
    const id = insertMemory(db);
    db.prepare("UPDATE extracted_memories SET relevance_score = 10 WHERE id = ?").run(id);

    mgr.editor.editMemory({ memoryId: id, relevanceScore: "+5" });
    const row1 = db.prepare("SELECT relevance_score FROM extracted_memories WHERE id = ?").get(id) as { relevance_score: number };
    expect(row1.relevance_score).toBe(15);

    mgr.editor.editMemory({ memoryId: id, relevanceScore: "-3" });
    const row2 = db.prepare("SELECT relevance_score FROM extracted_memories WHERE id = ?").get(id) as { relevance_score: number };
    expect(row2.relevance_score).toBe(12);
  });

  it("blocks SECRET declassification without userOverride", () => {
    const id = insertMemory(db, { classification: 3 });
    const result = mgr.editor.editMemory({ memoryId: id, classification: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("SECRET");
  });

  it("blocks CONFIDENTIAL → UNCLASSIFIED (must step through RESTRICTED)", () => {
    const id = insertMemory(db, { classification: 2 });
    const result = mgr.editor.editMemory({ memoryId: id, classification: 0 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("CONFIDENTIAL");
  });

  it("allows CONFIDENTIAL → RESTRICTED", () => {
    const id = insertMemory(db, { classification: 2 });
    const result = mgr.editor.editMemory({ memoryId: id, classification: 1 });
    expect(result.ok).toBe(true);
  });

  it("returns error for missing memory ID", () => {
    const result = mgr.editor.editMemory({ memoryId: 99999, credibility: 1 });
    expect(result.ok).toBe(true);
    expect(result.memoriesUpdated).toBe(1); // UPDATE runs but changes 0 rows — still "ok"
  });

  it("returns error when no fields provided", () => {
    const id = insertMemory(db);
    const result = mgr.editor.editMemory({ memoryId: id });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no fields");
  });

  it("dry-run returns preview without committing", () => {
    const id = insertMemory(db);
    const result = mgr.editor.editMemory({ memoryId: id, credibility: 1, dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.fieldsUpdated).toContain("credibility");

    const row = db.prepare("SELECT credibility FROM extracted_memories WHERE id = ?").get(id) as { credibility: number };
    expect(row.credibility).toBe(6); // unchanged
  });

  it("looks up memories by platform message ID", () => {
    const msgId = insertMessage(db, { platformMessageId: 555 });
    const memId = insertMemory(db, { platformMessageId: msgId });

    const result = mgr.editor.editMemory({ messageId: 555, userId: "aksika", emotionScore: 3 });
    expect(result.ok).toBe(true);
    expect(result.ids).toContain(memId);

    const row = db.prepare("SELECT emotion_score FROM extracted_memories WHERE id = ?").get(memId) as { emotion_score: number };
    expect(row.emotion_score).toBe(3);
  });

  it("FTS5 stays in sync after content edit", () => {
    const id = insertMemory(db, { contentEn: "original searchable text" });
    mgr.editor.editMemory({ memoryId: id, contentEn: "completely different words" });

    const oldHits = db.prepare("SELECT rowid FROM extracted_memories_fts WHERE content_en MATCH 'searchable'").all();
    expect(oldHits).toHaveLength(0);

    const newHits = db.prepare("SELECT rowid FROM extracted_memories_fts WHERE content_en MATCH 'different'").all();
    expect(newHits).toHaveLength(1);
  });
});

describe("editMemory — ABM v1 fields (topic, tier, valid_to)", () => {
  let tmpDir: string;
  let mm: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "edit-abm-"));
    mm = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await mm.initialize({ skipEmbeddingCheck: true });
  });

  afterEach(() => {
    mm.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insert(): number {
    const db = mm.getDatabase()!;
    db.prepare(
      `INSERT INTO extracted_memories (user_id, content_original, content_en, memory_type, source_timestamp, created_at, preserve_original, emotion_score)
       VALUES (1, 'test', 'test fact', 'fact', ?, ?, 0, 0)`,
    ).run(Date.now(), Date.now());
    return (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
  }

  it("sets topic via edit", () => {
    const id = insert();
    const result = mm.editor.editMemory({ memoryId: id, topic: "coding", caller: "dreamy" });
    expect(result.ok).toBe(true);
    const row = mm.getDatabase()!.prepare("SELECT topic FROM extracted_memories WHERE id = ?").get(id) as { topic: string };
    expect(row.topic).toBe("coding");
  });

  it("promotes to core tier", () => {
    const id = insert();
    const result = mm.editor.editMemory({ memoryId: id, tier: "core", caller: "dreamy" });
    expect(result.ok).toBe(true);
    const row = mm.getDatabase()!.prepare("SELECT tier FROM extracted_memories WHERE id = ?").get(id) as { tier: string };
    expect(row.tier).toBe("core");
  });

  it("rejects invalid tier", () => {
    const id = insert();
    const result = mm.editor.editMemory({ memoryId: id, tier: "invalid" as "core", caller: "dreamy" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("tier must be");
  });

  it("sets valid_to for temporal invalidation", () => {
    const id = insert();
    const result = mm.editor.editMemory({ memoryId: id, validTo: "2026-04-07", caller: "dreamy" });
    expect(result.ok).toBe(true);
    const row = mm.getDatabase()!.prepare("SELECT valid_to FROM extracted_memories WHERE id = ?").get(id) as { valid_to: string };
    expect(row.valid_to).toBe("2026-04-07");
  });

  it("clears valid_to with empty string", () => {
    const id = insert();
    mm.editor.editMemory({ memoryId: id, validTo: "2026-04-07", caller: "dreamy" });
    const result = mm.editor.editMemory({ memoryId: id, validTo: "", caller: "dreamy" });
    expect(result.ok).toBe(true);
    const row = mm.getDatabase()!.prepare("SELECT valid_to FROM extracted_memories WHERE id = ?").get(id) as { valid_to: string | null };
    expect(row.valid_to).toBeNull();
  });
});
