import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager, getMemoryDb } from "./memory-manager.js"
import { makeMemoryTestConfig } from "./test-helpers.js";

describe("MaintenanceService.runPreSleepTasks", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "presleep-"));
    const memDir = join(tmpDir, "memory");
    mkdirSync(join(memDir, "sleep"), { recursive: true });
    manager = new MemoryManager(makeMemoryTestConfig(memDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs without errors on empty DB", async () => {
    const sleepData = manager.getSleepData();
    const r = await manager.maintenance.runPreSleepTasks(manager, sleepData);
    expect(r.walOk).toBe(true);
    expect(r.ftsOk).toBe(true);
    expect(r.purged).toBe(0);
    expect(r.deduped).toBe(0);
  });

  it("purges expired garbage entries", async () => {
    const memDir = join(tmpDir, "memory");
    // Record a message so we have something to purge
    manager.recordMessage({ role: "user", content: "test", timestamp: 1000, userId: "master", sessionId: "s1" });
    const msgId = (manager as unknown as { db: { prepare: (s: string) => { get: () => { id: number } } } }).db
      .prepare("SELECT id FROM messages ORDER BY id DESC LIMIT 1").get().id;

    // Write garbage.json with expired entry (>7 days old)
    const oldDate = new Date(Date.now() - 8 * 86400000).toISOString();
    writeFileSync(join(memDir, "garbage.json"), JSON.stringify({ [msgId]: oldDate }));

    const sleepData = manager.getSleepData();
    const r = await manager.maintenance.runPreSleepTasks(manager, sleepData);
    expect(r.purged).toBe(1);
  });

  it("deduplicates consecutive identical messages", async () => {
    manager.recordMessage({ role: "user", content: "hello", timestamp: 1000, userId: "master", sessionId: "s1" });
    manager.recordMessage({ role: "user", content: "hello", timestamp: 1001, userId: "master", sessionId: "s1" });

    const sleepData = manager.getSleepData();
    const r = await manager.maintenance.runPreSleepTasks(manager, sleepData);
    expect(r.deduped).toBe(1);
  });
});

describe("MaintenanceService.runPreflight embedding integrity (#1659)", () => {
  let tmpDir: string;
  let manager: MemoryManager;
  let db: import("better-sqlite3").Database & object;
  const originalDimensions = process.env.EMBEDDING_DIMENSIONS;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "preflight-"));
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    manager = new MemoryManager(makeMemoryTestConfig(memDir));
    await manager.initialize();
    db = getMemoryDb(manager)!;
  });

  afterEach(async () => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalDimensions === undefined) delete process.env.EMBEDDING_DIMENSIONS;
    else process.env.EMBEDDING_DIMENSIONS = originalDimensions;
    (await import("./env-schema.js"))._resetAbmindEnv();
  });

  function insertMemory(userId: string, embedding: Buffer): number {
    const r = db.prepare(`
      INSERT INTO extracted_memories (user_id, content_original, content_en, memory_type, source_timestamp, created_at, embedding)
      VALUES (?, 'c', 'c', 'fact', ?, ?, ?)
    `).run(userId, Date.now(), Date.now(), embedding);
    return Number(r.lastInsertRowid);
  }

  function validFloat32(dims: number): Buffer {
    const buf = Buffer.alloc(dims * 4);
    for (let i = 0; i < dims; i++) buf.writeFloatLE(0.25, i * 4);
    return buf;
  }

  function nonFiniteFloat32(dims: number): Buffer {
    const buf = validFloat32(dims);
    buf.writeFloatLE(Number.NaN, 0);
    return buf;
  }

  it("nulls only wrong-length and non-finite rows, preserving owner/revision CAS", async () => {
    process.env.EMBEDDING_DIMENSIONS = "768";
    (await import("./env-schema.js"))._resetAbmindEnv();

    const validF32 = insertMemory("master", validFloat32(768));
    const validI8 = insertMemory("master", Buffer.alloc(768, 3));
    const wrongLen = insertMemory("master", Buffer.alloc(500, 1));
    const nonFinite = insertMemory("other", nonFiniteFloat32(768));

    const result = await manager.maintenance.runPreflight();
    expect(result.corruptedEmbeddingsFixed).toBe(2);

    const embeddingFor = (id: number): Buffer | null =>
      (db.prepare("SELECT embedding FROM extracted_memories WHERE id = ?").get(id) as { embedding: Buffer | null }).embedding;

    expect(embeddingFor(validF32)).not.toBeNull();
    expect(embeddingFor(validF32)!.byteLength).toBe(768 * 4);
    expect(embeddingFor(validI8)).not.toBeNull();
    expect(embeddingFor(validI8)!.byteLength).toBe(768);
    expect(embeddingFor(wrongLen)).toBeNull();
    expect(embeddingFor(nonFinite)).toBeNull();
  });

  it("accepts a 384-dimension provider without nulling its valid embeddings", async () => {
    process.env.EMBEDDING_DIMENSIONS = "384";
    (await import("./env-schema.js"))._resetAbmindEnv();

    const validF32 = insertMemory("master", validFloat32(384));
    const wrongLen = insertMemory("master", validFloat32(768));

    const result = await manager.maintenance.runPreflight();
    expect(result.corruptedEmbeddingsFixed).toBe(1);

    const embeddingFor = (id: number): Buffer | null =>
      (db.prepare("SELECT embedding FROM extracted_memories WHERE id = ?").get(id) as { embedding: Buffer | null }).embedding;

    expect(embeddingFor(validF32)).not.toBeNull();
    expect(embeddingFor(wrongLen)).toBeNull();
  });

  it("the nulling update is scoped to the selected (id, user_id, semantic_revision) tuple", async () => {
    process.env.EMBEDDING_DIMENSIONS = "768";
    (await import("./env-schema.js"))._resetAbmindEnv();

    const id = insertMemory("master", Buffer.alloc(500, 1));
    const row = db.prepare("SELECT id, user_id, semantic_revision FROM extracted_memories WHERE id = ?").get(id) as { id: number; user_id: string; semantic_revision: number };

    const wrongOwner = db.prepare("UPDATE extracted_memories SET embedding = NULL WHERE id = ? AND user_id = ? AND semantic_revision = ?")
      .run(row.id, "not-the-owner", row.semantic_revision);
    expect(wrongOwner.changes).toBe(0);

    const wrongRevision = db.prepare("UPDATE extracted_memories SET embedding = NULL WHERE id = ? AND user_id = ? AND semantic_revision = ?")
      .run(row.id, row.user_id, row.semantic_revision + 100);
    expect(wrongRevision.changes).toBe(0);

    const result = await manager.maintenance.runPreflight();
    expect(result.corruptedEmbeddingsFixed).toBe(1);
    const after = db.prepare("SELECT embedding FROM extracted_memories WHERE id = ?").get(id) as { embedding: Buffer | null };
    expect(after.embedding).toBeNull();
  });
});

describe("MaintenanceService forget operations (#1511)", () => {
  let tmpDir: string;
  let manager: MemoryManager;
  let db: import("better-sqlite3").Database & object;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "forget-"));
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    manager = new MemoryManager(makeMemoryTestConfig(memDir));
    await manager.initialize();
    db = getMemoryDb(manager)!;
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertMemory(userId: string, contentEn: string, sourceMessageIds: string): number {
    const result = db.prepare(`
      INSERT INTO extracted_memories
        (user_id, content_original, content_en, memory_type, source_timestamp, created_at, source_message_ids)
      VALUES (?, ?, ?, 'fact', ?, ?, ?)
    `).run(userId, contentEn, contentEn, Date.now(), Date.now(), sourceMessageIds);
    return Number(result.lastInsertRowid);
  }

  it("forgetSession returns truthful counts and removes linked memories", async () => {
    manager.recordMessage({ role: "user", content: "session fact source", timestamp: 1000, userId: "master", sessionId: "s1" });
    const msg = db.prepare("SELECT id FROM messages WHERE session_id = ? AND user_id = ?").get("s1", "master") as { id: number };
    const mem = insertMemory("master", "session fact", String(msg.id));
    manager.recordMessage({ role: "user", content: "other session", timestamp: 1001, userId: "master", sessionId: "s2" });

    const result = manager.maintenance.forgetSession("master", "s1");
    expect(result).toEqual({ messagesRemoved: 1, linkedMemoriesRemoved: 1, embeddingsRemoved: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE user_id = ?").get("master")!.c).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS c FROM extracted_memories WHERE id = ?").get(mem)!.c).toBe(0);
  });

  it("forgetRange returns a zero no-op when selection finds nothing", () => {
    const result = manager.maintenance.forgetRange("master", new Date(0), new Date(Date.now() - 86400000));
    expect(result).toEqual({ messagesRemoved: 0, linkedMemoriesRemoved: 0, embeddingsRemoved: 0 });
  });

  it("propagates cascade failures instead of returning zeros", async () => {
    manager.recordMessage({ role: "user", content: "broken source", timestamp: 1000, userId: "master", sessionId: "s1" });
    const msg = db.prepare("SELECT id FROM messages WHERE session_id = ? AND user_id = ?").get("s1", "master") as { id: number };
    insertMemory("master", "broken fact", String(msg.id));
    db.exec(`
      CREATE TRIGGER abort_forget_messages BEFORE DELETE ON messages BEGIN
        SELECT RAISE(ABORT, 'forced forget failure');
      END;
    `);

    expect(() => manager.maintenance.forgetSession("master", "s1")).toThrow(/forced forget failure/);
    db.exec("DROP TRIGGER abort_forget_messages");
    expect(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ?").get("s1")!.c).toBe(1);
  });

  it("forgets sessions larger than the public cascade batch limit in one operation", () => {
    const insert = db.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, 'user', ?, ?)",
    );
    for (let i = 0; i < 513; i++) {
      insert.run("master", "large-session", `message-${i}`, i);
    }

    const result = manager.maintenance.forgetSession("master", "large-session");

    expect(result).toEqual({ messagesRemoved: 513, linkedMemoriesRemoved: 0, embeddingsRemoved: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND session_id = ?").get("master", "large-session")!.c).toBe(0);
  });

  it("rolls back earlier maintenance batches when a later batch fails", () => {
    const insert = db.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, 'user', ?, ?)",
    );
    for (let i = 0; i < 513; i++) {
      insert.run("master", "failing-large-session", `message-${i}`, i);
    }
    db.exec(`
      CREATE TRIGGER abort_late_forget_messages BEFORE DELETE ON messages
      WHEN OLD.id > 512 BEGIN
        SELECT RAISE(ABORT, 'forced late forget failure');
      END;
    `);

    expect(() => manager.maintenance.forgetSession("master", "failing-large-session")).toThrow(/forced late forget failure/);
    db.exec("DROP TRIGGER abort_late_forget_messages");
    expect(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND session_id = ?").get("master", "failing-large-session")!.c).toBe(513);
  });
});
