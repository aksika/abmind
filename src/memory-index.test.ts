import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import type Database from "better-sqlite3";
import type { MessageRecord } from "./mem-types.js";

function makeRecord(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    role: "user",
    content: "Hello world",
    timestamp: Date.now(),
    userId: "user-100",
    sessionId: "sess-001",
    ...overrides,
  };
}

describe("MemoryIndex", () => {
  let tmpDir: string;
  let db: Database.Database;
  let index: MemoryIndex;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mi-test-"));
    db = initializeDatabase(join(tmpDir, "test.db"));
    index = new MemoryIndex(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializeDatabase creates all required tables", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger') ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain("messages");
    expect(names).toContain("content_en_trigram");
    expect(names).toContain("content_original_trigram");
    expect(names).toContain("content_en_trigram_ai");
    expect(names).toContain("content_original_trigram_ai");
  });

  it("index inserts a message and returns its id", () => {
    const record = makeRecord({ content: "testing insertion" });
    const id = index.index(record);

    expect(id).toBeGreaterThan(0);

    const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as {
      content: string;
    };
    expect(row.content).toBe("testing insertion");
  });

  it("index a message and search for it", () => {
    const record = makeRecord({ content: "quantum computing breakthrough" });
    index.index(record);

    const results = index.search("quantum");
    expect(results).toHaveLength(1);
    expect(results[0]!.record.content).toBe("quantum computing breakthrough");
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it("search returns results ordered by relevance", () => {
    // Insert messages with varying relevance to "typescript"
    index.index(
      makeRecord({
        content: "typescript typescript typescript is great",
        timestamp: 1000,
      }),
    );
    index.index(
      makeRecord({
        content: "I once heard about typescript",
        timestamp: 2000,
      }),
    );
    index.index(
      makeRecord({
        content:
          "typescript compiler typescript types typescript generics typescript",
        timestamp: 3000,
      }),
    );

    const results = index.search("typescript");
    expect(results.length).toBeGreaterThanOrEqual(2);

    // Scores should be in descending order (most relevant first)
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i]!.score).toBeGreaterThanOrEqual(results[i + 1]!.score);
    }
  });

  it("search with userId filter returns only matching chat", () => {
    index.index(makeRecord({ userId: "user-1", content: "alpha beta gamma" }));
    index.index(makeRecord({ userId: "user-2", content: "alpha delta epsilon" }));
    index.index(makeRecord({ userId: "user-1", content: "alpha zeta eta" }));

    const results = index.search("alpha", { userId: "user-1" });
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.record.userId).toBe("user-1");
    }
  });

  it("search with date range filter", () => {
    index.index(
      makeRecord({ content: "early message about dogs", timestamp: 1000 }),
    );
    index.index(
      makeRecord({ content: "middle message about dogs", timestamp: 5000 }),
    );
    index.index(
      makeRecord({ content: "late message about dogs", timestamp: 9000 }),
    );

    const results = index.search("dogs", {
      startTime: 2000,
      endTime: 6000,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.record.content).toBe("middle message about dogs");
  });

  it("removeSession removes all entries for that session", () => {
    index.index(
      makeRecord({
        userId: "user-1",
        sessionId: "s1",
        content: "unique xylophone word",
      }),
    );
    index.index(
      makeRecord({
        userId: "user-1",
        sessionId: "s1",
        content: "another xylophone entry",
      }),
    );
    index.index(
      makeRecord({
        userId: "user-1",
        sessionId: "s2",
        content: "different xylophone session",
      }),
    );

    index.removeSession("user-1", "s1");

    const results = index.search("xylophone");
    expect(results).toHaveLength(1);
    expect(results[0]!.record.sessionId).toBe("s2");
  });

  it("prune keeps most recent messages", () => {
    for (let i = 0; i < 10; i++) {
      index.index(
        makeRecord({
          userId: "user-1",
          content: `message number ${i} about pruning`,
          timestamp: 1000 + i * 100,
        }),
      );
    }

    index.prune("user-1", 3);

    const remaining = db
      .prepare(
        "SELECT * FROM messages WHERE user_id = 'user-1' ORDER BY timestamp DESC",
      )
      .all() as Array<{ timestamp: number; content: string }>;

    expect(remaining).toHaveLength(3);
    // The 3 most recent should remain (timestamps 1700, 1800, 1900)
    expect(remaining[0]!.timestamp).toBe(1900);
    expect(remaining[1]!.timestamp).toBe(1800);
    expect(remaining[2]!.timestamp).toBe(1700);
  });

  it("search with no results returns empty array", () => {
    index.index(makeRecord({ content: "hello world" }));
    const results = index.search("xyznonexistent");
    expect(results).toHaveLength(0);
  });

  it("search with empty query returns empty array", () => {
    index.index(makeRecord({ content: "hello world" }));
    const results = index.search("");
    expect(results).toHaveLength(0);
  });

  it("search respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      index.index(makeRecord({ content: `searchable term number ${i}` }));
    }

    const results = index.search("searchable", { limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("prune does not affect other chats", () => {
    for (let i = 0; i < 5; i++) {
      index.index(
        makeRecord({
          userId: "user-1",
          content: `chat1 msg ${i}`,
          timestamp: 1000 + i,
        }),
      );
      index.index(
        makeRecord({
          userId: "user-2",
          content: `chat2 msg ${i}`,
          timestamp: 1000 + i,
        }),
      );
    }

    index.prune("user-1", 2);

    const chat1Count = (
      db
        .prepare("SELECT COUNT(*) as cnt FROM messages WHERE user_id = 'user-1'")
        .get() as { cnt: number }
    ).cnt;
    const chat2Count = (
      db
        .prepare("SELECT COUNT(*) as cnt FROM messages WHERE user_id = 'user-2'")
        .get() as { cnt: number }
    ).cnt;

    expect(chat1Count).toBe(2);
    expect(chat2Count).toBe(5);
  });
});
