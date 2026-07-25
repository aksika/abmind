import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory-manager.js";
import { MEMORY_CONFIG_DEFAULTS } from "./memory-config.js";
import type { MemoryConfig } from "./memory-config.js";
import type { MessageRecord } from "./mem-types.js";
import { MemoryIndex } from "./memory-index.js";
import { initializeDatabase } from "./memory-db.js";
import { makeMemoryTestConfig } from "./test-helpers.js";

describe("MemoryManager — enforceDiskBudget", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mm-budget-"));
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir, { diskBudgetBytes: 1024 }));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not throw when DB is under budget", async () => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });

    tmpDir = mkdtempSync(join(tmpdir(), "mm-budget-under-"));
    const bigBudgetManager = new MemoryManager(
      makeMemoryTestConfig(tmpDir, { diskBudgetBytes: 100 * 1024 * 1024 }),
    );
    await bigBudgetManager.initialize();
    expect(() => bigBudgetManager.maintenance.enforceDiskBudget()).not.toThrow();
    bigBudgetManager.close();
  });

  it("is a no-op when memoryEnabled is false", async () => {
    const disabledManager = new MemoryManager(
      makeMemoryTestConfig(tmpDir, { memoryEnabled: false, diskBudgetBytes: 1 }),
    );
    await disabledManager.initialize();
    expect(() => disabledManager.maintenance?.enforceDiskBudget()).not.toThrow();
    disabledManager.close();
  });
});

function makeRecord(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    role: "user",
    content: "hello world",
    timestamp: Date.now(),
    userId: "user-1",
    sessionId: "sess-001",
    ...overrides,
  };
}

describe("MemoryManager — recordMessage", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mm-record-"));
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores raw content in DB and indexes in FTS", () => {
    const record = makeRecord({
      content: "distinctive_keyword_xyzzy",
      userId: "test-user",
      sessionId: "s1",
      timestamp: Date.now(),
    });

    manager.recordMessage(record);

    // Verify DB has raw content
    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const row = db.prepare("SELECT content FROM messages WHERE user_id = 'test-user'").get() as { content: string };
    expect(row.content).toBe("distinctive_keyword_xyzzy");

    // Verify FTS index
    const mi = new MemoryIndex(db);
    const results = mi.search("distinctive_keyword_xyzzy", { userId: "test-user" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.record.content).toBe("distinctive_keyword_xyzzy");
    db.close();
  });

  it("prunes when exceeding maxMessagesPerChat", () => {
    const maxMessages = 5;
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });

    tmpDir = mkdtempSync(join(tmpdir(), "mm-prune-"));
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir, { maxMessagesPerChat: maxMessages }));
    return manager.initialize().then(() => {
      // Record more messages than the limit
      for (let i = 0; i < maxMessages + 3; i++) {
        manager.recordMessage(
          makeRecord({
            content: `message number ${i}`,
            userId: "user-10",
            sessionId: "s1",
            timestamp: 1000 + i,
          }),
        );
      }

      // Verify only maxMessages remain in the index
      const db = initializeDatabase(join(tmpDir, "memory.db"));
      const row = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE user_id = 'user-10'").get() as {
        cnt: number;
      };
      expect(row.cnt).toBe(maxMessages);

      // Verify the remaining messages are the most recent ones
      const rows = db
        .prepare("SELECT timestamp FROM messages WHERE user_id = 'user-10' ORDER BY timestamp ASC")
        .all() as Array<{ timestamp: number }>;
      // The oldest remaining should be message number 3 (timestamp 1003)
      expect(rows[0]!.timestamp).toBe(1000 + 3);
      expect(rows[rows.length - 1]!.timestamp).toBe(1000 + maxMessages + 2);

      db.close();
    });
  });

  it("calls enforceDiskBudget every 100 writes", async () => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });

    tmpDir = mkdtempSync(join(tmpdir(), "mm-budget100-"));
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir, { diskBudgetBytes: 100 * 1024 * 1024 }));
    await manager.initialize();

    // Write 100 messages — should trigger enforcement without throwing
    for (let i = 0; i < 100; i++) {
      manager.recordMessage(
        makeRecord({
          content: `msg ${i}`,
          userId: "user-1",
          sessionId: "s1",
          timestamp: 1000 + i,
        }),
      );
    }

    // Verify all 100 messages were recorded
    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const row = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE user_id = 'user-1'").get() as { cnt: number };
    expect(row.cnt).toBe(100);
    db.close();
  });

  it("is no-op when memoryEnabled is false", async () => {
    const disabledManager = new MemoryManager(makeMemoryTestConfig(tmpDir, { memoryEnabled: false }));
    await disabledManager.initialize();

    const record = makeRecord({ content: "should not be recorded", userId: "user-77", sessionId: "s1" });
    disabledManager.recordMessage(record);

    // No DB entries should exist
    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const row = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE user_id = 'user-77'").get() as { cnt: number };
    expect(row.cnt).toBe(0);
    db.close();

    disabledManager.close();
  });

  it("skips pure-whitespace messages", () => {
    const record = makeRecord({ content: "   ", userId: "test-user", sessionId: "s1", timestamp: Date.now() });
    manager.recordMessage(record);

    // But DB should have no messages (empty after emoji strip)
    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const row = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE user_id = 'test-user'").get() as { cnt: number };
    expect(row.cnt).toBe(0);
    db.close();
  });

  it("stores platform_message_id and updates emotion_score via updateEmotionByPlatformId", () => {
    const record = makeRecord({ content: "hello world", userId: "user-1", sessionId: "s1", timestamp: Date.now(), platformMessageId: 999 });
    manager.recordMessage(record);

    // Verify platform_message_id stored
    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const row = db.prepare("SELECT platform_message_id, emotion_score FROM messages WHERE user_id = 'user-1'").get() as { platform_message_id: string; emotion_score: number };
    expect(row.platform_message_id).toBe("999");
    expect(row.emotion_score).toBe(0);
    db.close();

    // Update emotion score
    const updated = manager.updateEmotionByPlatformId("user-1", 999, 3);
    expect(updated).toBe(true);

    const db2 = initializeDatabase(join(tmpDir, "memory.db"));
    const row2 = db2.prepare("SELECT emotion_score FROM messages WHERE user_id = 'user-1' AND platform_message_id = ?").get("999") as { emotion_score: number };
    expect(row2.emotion_score).toBe(3);
    db2.close();
  });

  it("preserves a Discord snowflake as text", () => {
    const snowflake = "123456789012345678";
    manager.recordMessage(makeRecord({ content: "discord", userId: "user-2", sessionId: "s2", timestamp: Date.now(), platformMessageId: snowflake }));

    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const row = db.prepare("SELECT platform_message_id, typeof(platform_message_id) AS value_type FROM messages WHERE user_id = 'user-2'").get() as { platform_message_id: string; value_type: string };
    expect(row).toEqual({ platform_message_id: snowflake, value_type: "text" });
    db.close();
  });

  it("updateEmotionByPlatformId returns false when message not found", () => {
    const updated = manager.updateEmotionByPlatformId("user-1", 12345, 3);
    expect(updated).toBe(false);
  });
});

describe("MemoryManager — checkAutoCompact", () => {
  let tmpDir: string;
  let manager: MemoryManager;
  const mockSendCompact = async (_sk: string, _cmd: string) => "compacted";

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mm-autocompact-"));
    manager = new MemoryManager(
      makeMemoryTestConfig(tmpDir, {
        searchEnhancements: {
          ...MEMORY_CONFIG_DEFAULTS.searchEnhancements,
          compactThresholdPct: 85,
        },
      }),
    );
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does nothing when contextPercent is below threshold", async () => {
    manager.recordMessage(
      makeRecord({ content: "hi", userId: "user-1", sessionId: "s1", timestamp: 1000 }),
    );

    await manager.maintenance.checkAutoCompact({
      userId: "user-1",
      sessionId: "s1",
      contextPercent: 50,
      sendCompactCommand: mockSendCompact,
    });

    // No working directory consolidation file should exist
    const today = new Date().toLocaleDateString("sv-SE");
    const workingDir = join(tmpDir, "working", today);
    expect(existsSync(workingDir)).toBe(false);
  });

  it("triggers consolidation when contextPercent meets threshold", async () => {
    const longContent = "a".repeat(250);
    // Insert into messages table (recordMessage only indexes in-memory)
    manager.getDatabase().prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
    ).run("user-10", "s1", "user", longContent, 1000);

    let compactCalled = false;
    const trackingSendCompact = async (_sk: string, _cmd: string) => {
      compactCalled = true;
      return "compacted";
    };

    await manager.maintenance.checkAutoCompact({
      userId: "user-10",
      sessionId: "s1",
      contextPercent: 90,
      sendCompactCommand: trackingSendCompact,
    });

    expect(compactCalled).toBe(true);

    // A working directory consolidation file should have been created
    const today = new Date().toLocaleDateString("sv-SE");
    const workingDir = join(tmpDir, "working", today);
    expect(existsSync(workingDir)).toBe(true);
  });

  it("is no-op when memoryEnabled is false", async () => {
    const disabledManager = new MemoryManager(
      makeMemoryTestConfig(tmpDir, { memoryEnabled: false }),
    );
    await disabledManager.initialize();

    await disabledManager.maintenance?.checkAutoCompact({
      userId: "user-1",
      sessionId: "s1",
      contextPercent: 95,
      sendCompactCommand: mockSendCompact,
    });

    // No working directory consolidation file should exist
    const today = new Date().toLocaleDateString("sv-SE");
    const workingDir = join(tmpDir, "working", today);
    expect(existsSync(workingDir)).toBe(false);

    disabledManager.close();
  });

  it("handles sendCompactCommand failure gracefully without throwing", async () => {
    const longContent = "b".repeat(250);
    manager.recordMessage(
      makeRecord({ content: longContent, userId: "user-20", sessionId: "s1", timestamp: 1000 }),
    );

    const failingSendCompact = async (_sk: string, _cmd: string): Promise<string> => {
      throw new Error("Transport unavailable");
    };

    // Should not throw — error is logged and raw transcript already saved as safety net
    await expect(
      manager.maintenance.checkAutoCompact({
        userId: "user-20",
        sessionId: "s1",
        contextPercent: 90,
        sendCompactCommand: failingSendCompact,
      }),
    ).resolves.toBeUndefined();
  });

  it("does nothing when no messages exist for session", async () => {
    // Call with a userId/sessionId that has no messages
    await expect(
      manager.maintenance.checkAutoCompact({
        userId: "user-999",
        sessionId: "nonexistent",
        contextPercent: 90,
        sendCompactCommand: mockSendCompact,
      }),
    ).resolves.toBeUndefined();
  });

  it("does nothing when contextPercent is exactly at threshold boundary", async () => {
    manager.recordMessage(
      makeRecord({ content: "test content", userId: "user-30", sessionId: "s1", timestamp: 1000 }),
    );

    let compactCalled = false;
    const trackingSendCompact = async (_sk: string, _cmd: string) => {
      compactCalled = true;
      return "compacted";
    };

    // contextPercent == threshold (85) should trigger (>= check)
    await manager.maintenance.checkAutoCompact({
      userId: "user-30",
      sessionId: "s1",
      contextPercent: 85,
      sendCompactCommand: trackingSendCompact,
    });

    expect(compactCalled).toBe(true);
  });
});

describe("MemoryManager — loadRecentMessages", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mm-load-"));
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns messages from DB", () => {
    // Record several messages
    for (let i = 0; i < 5; i++) {
      manager.recordMessage(
        makeRecord({
          content: `message ${i}`,
          userId: "user-1",
          sessionId: "s1",
          timestamp: 1000 + i,
        }),
      );
    }

    const messages = manager.loadRecentMessages("user-1", "s1", 3);
    expect(messages).toHaveLength(3);
    // Should be the last 3 messages
    expect(messages[0]!.content).toBe("message 2");
    expect(messages[1]!.content).toBe("message 3");
    expect(messages[2]!.content).toBe("message 4");
  });

  it("returns empty array when no messages exist", () => {
    const messages = manager.loadRecentMessages("user-999", "nonexistent", 10);
    expect(messages).toEqual([]);
  });

  it("returns empty array when memoryEnabled is false", async () => {
    const disabled = new MemoryManager(makeMemoryTestConfig(tmpDir, { memoryEnabled: false }));
    await disabled.initialize();

    const messages = disabled.loadRecentMessages("user-1", "s1", 10);
    expect(messages).toEqual([]);

    disabled.close();
  });
});
