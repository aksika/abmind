import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager, getMemoryDb } from "./memory-manager.js";
import { MEMORY_CONFIG_DEFAULTS } from "./memory-config.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import type { MessageRecord } from "./mem-types.js";

function makeRecord(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    role: "user",
    content: "hello",
    timestamp: Date.now(),
    userId: "user-1",
    sessionId: "s1",
    ...overrides,
  };
}

describe("Memory system — end-to-end smoke test", () => {
  let tmpDir: string;
  let mm: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "e2e-mem-"));
    mm = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await mm.initialize();
  });

  afterEach(() => {
    mm.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("full lifecycle: record → search → restore → context", async () => {
    const userId = "test-user";
    const sess1 = "sess-alpha";
    const sess2 = "sess-beta";

    // 1. Record messages across two sessions
    for (let i = 0; i < 5; i++) {
      mm.store.recordMessage(makeRecord({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `session1 message ${i} about quantum physics`,
        userId,
        sessionId: sess1,
        timestamp: 1000 + i,
      }));
    }
    for (let i = 0; i < 5; i++) {
      mm.store.recordMessage(makeRecord({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `session2 message ${i} about machine learning`,
        userId,
        sessionId: sess2,
        timestamp: 2000 + i,
      }));
    }

    // 2. Search for a keyword — verify results
    const searchResults = await mm.search("quantum", { userId });
    expect(searchResults.length).toBeGreaterThanOrEqual(1);
    expect(searchResults[0]!.record.content).toContain("quantum");

    const mlResults = await mm.search("machine learning", { userId });
    expect(mlResults.length).toBeGreaterThanOrEqual(1);

    // 3. Load recent messages from session 2 — verify count
    const recent = mm.loadRecentMessages(userId, sess2, 3);
    expect(recent).toHaveLength(3);
    expect(recent[0]!.content).toContain("session2 message 2");
    expect(recent[2]!.content).toContain("session2 message 4");

    // 5. Search — verify FTS5 still works after multiple sessions
    const searchResults2 = await mm.search("quantum", { userId, limit: 5 });
    expect(searchResults2.length).toBeGreaterThan(0);

    // 8. Close and reinitialize — verify data survives
    mm.close();
    mm = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await mm.initialize();

    const searchAfterRestart = await mm.search("quantum", { userId });
    expect(searchAfterRestart.length).toBeGreaterThanOrEqual(1);
  });

  it("disk budget enforcement deletes oldest transcripts", async () => {
    // Use a tiny budget
    mm.close();
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = mkdtempSync(join(tmpdir(), "e2e-budget-"));
    mm = new MemoryManager(makeMemoryTestConfig(tmpDir, { diskBudgetBytes: 1 }));
    await mm.initialize();

    // Record enough messages to create transcript files
    for (let i = 0; i < 10; i++) {
      mm.store.recordMessage(makeRecord({
        content: `budget test message ${i} with some padding text to increase file size`,
        userId: "user-1",
        sessionId: "s1",
        timestamp: 1000 + i,
      }));
    }

    // Force budget enforcement
    mm.maintenance.enforceDiskBudget();

    // Transcript file should be deleted (budget is 1 byte, DB alone exceeds it)
    const transcriptPath = join(tmpDir, "transcripts", "1", "s1.jsonl");
    expect(existsSync(transcriptPath)).toBe(false);
  });

  it("auto-compaction triggers when context percent exceeds threshold", async () => {
    mm.close();
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = mkdtempSync(join(tmpdir(), "e2e-autocompact-"));
    mm = new MemoryManager(makeMemoryTestConfig(tmpDir, {
      searchEnhancements: {
        ...MEMORY_CONFIG_DEFAULTS.searchEnhancements,
        compactThresholdPct: 85,
      },
    }));
    await mm.initialize();

    // Insert into messages table (recordMessage only indexes in-memory)
    getMemoryDb(mm)!.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
    ).run("aksika", "s1", "user", "x".repeat(250), 1000);

    const mockSendCompact = async (_sk: string, _cmd: string) => "compacted";
    await mm.maintenance.checkAutoCompact({
      userId: "aksika",
      sessionId: "s1",
      contextPercent: 90,
      sendCompactCommand: mockSendCompact,
    });

    // Working directory safety-net file should exist
    const today = new Date().toLocaleDateString("sv-SE");
    const workingDir = join(tmpDir, "working", today);
    expect(existsSync(workingDir)).toBe(true);
  });
});
