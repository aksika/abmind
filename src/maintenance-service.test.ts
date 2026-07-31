import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory-manager.js";
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

describe("MaintenanceService forget operations (#1511)", () => {
  let tmpDir: string;
  let manager: MemoryManager;
  let db: ReturnType<MemoryManager["getDatabase"]> & object;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "forget-"));
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    manager = new MemoryManager(makeMemoryTestConfig(memDir));
    await manager.initialize();
    db = manager.getDatabase()!;
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
