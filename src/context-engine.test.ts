import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ContextEngine, COMPACTION_THRESHOLD_PCT, TAIL_MIN_MESSAGES } from "../src/context-engine.js";
import { initializeDatabase } from "../src/memory-db.js";

describe("ContextEngine", () => {
  let db: Database.Database;
  let engine: ContextEngine;

  beforeEach(() => {
    db = initializeDatabase(":memory:");
    engine = new ContextEngine(db);
    // Seed messages
    const insert = db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)");
    for (let i = 1; i <= 50; i++) {
      insert.run("user1", "chat1", i % 2 === 1 ? "user" : "assistant", `Message ${i} content ${"x".repeat(200)}`, 1000000 + i * 1000);
    }
  });

  describe("buildContext", () => {
    it("returns all messages when no watermark exists", () => {
      const snap = engine.buildContext("chat1");
      expect(snap.messages.length).toBe(50);
      expect(snap.summaries.length).toBe(0);
      expect(snap.pendingCompaction).toBe(false);
    });

    it("returns messages from watermark onward", () => {
      // Manually set watermark
      db.prepare("INSERT INTO context_watermarks (chat_id, watermark_message_id, compaction_count) VALUES (?, ?, 1)").run("chat1", 20);
      const snap = engine.buildContext("chat1");
      expect(snap.messages[0]!.id).toBe(20);
      expect(snap.messages.length).toBe(31); // 20 through 50
    });

    it("includes non-archived summaries", () => {
      db.prepare("INSERT INTO context_summaries (chat_id, depth, content, token_estimate, source_message_start, source_message_end, classification, created_at) VALUES (?, 0, ?, 500, 1, 10, 1, ?)").run("chat1", "Summary content", Date.now());
      db.prepare("INSERT INTO context_watermarks (chat_id, watermark_message_id, compaction_count) VALUES (?, ?, 1)").run("chat1", 11);
      const snap = engine.buildContext("chat1");
      expect(snap.summaries.length).toBe(1);
      expect(snap.summaries[0]!.content).toBe("Summary content");
    });

    it("excludes archived summaries", () => {
      db.prepare("INSERT INTO context_summaries (chat_id, depth, content, token_estimate, source_message_start, source_message_end, classification, archived, created_at) VALUES (?, 0, ?, 500, 1, 10, 1, 1, ?)").run("chat1", "Archived", Date.now());
      const snap = engine.buildContext("chat1");
      expect(snap.summaries.length).toBe(0);
    });
  });

  describe("getCompactionChunk", () => {
    it("returns null when too few messages", () => {
      const db2 = initializeDatabase(":memory:");
      const engine2 = new ContextEngine(db2);
      const insert = db2.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)");
      for (let i = 1; i <= 5; i++) insert.run("u", "c", "user", "hi", 1000 + i);
      expect(engine2.getCompactionChunk("c", 200000)).toBeNull();
    });

    it("returns a chunk when messages exceed threshold", () => {
      // Add large messages to exceed tail
      const insert = db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)");
      for (let i = 51; i <= 100; i++) {
        insert.run("user1", "chat1", i % 2 === 1 ? "user" : "assistant", "x".repeat(2000), 1000000 + i * 1000);
      }
      const chunk = engine.getCompactionChunk("chat1", 200000);
      expect(chunk).not.toBeNull();
      expect(chunk!.messages.length).toBeGreaterThan(0);
      expect(chunk!.sourceStart).toBe(1);
    });

    it("does not include tool messages at chunk boundary", () => {
      // Insert messages where the boundary would land on a tool result
      const db2 = initializeDatabase(":memory:");
      const engine2 = new ContextEngine(db2);
      const insert = db2.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)");
      for (let i = 1; i <= 30; i++) {
        const role = i === 15 ? "tool" : (i % 2 === 1 ? "user" : "assistant");
        insert.run("u", "c", role, "x".repeat(1000), 1000 + i);
      }
      const chunk = engine2.getCompactionChunk("c", 200000);
      if (chunk) {
        const lastMsg = chunk.messages[chunk.messages.length - 1]!;
        expect(lastMsg.role).not.toBe("tool");
      }
    });
  });

  describe("persistSummary", () => {
    it("stores summary and advances watermark", () => {
      const id = engine.persistSummary("chat1", "Test summary", 100, 1, 20, 1, "test-model");
      expect(id).toBeGreaterThan(0);

      const wm = engine.getWatermark("chat1");
      expect(wm).not.toBeNull();
      expect(wm!.watermarkMessageId).toBe(21);
      expect(wm!.compactionCount).toBe(1);

      const summaries = engine.getSummaries("chat1");
      expect(summaries.length).toBe(1);
      expect(summaries[0]!.content).toBe("Test summary");
    });
  });

  describe("archiveContext", () => {
    it("archives summaries and advances watermark", () => {
      engine.persistSummary("chat1", "Summary 1", 100, 1, 10, 1);
      engine.persistSummary("chat1", "Summary 2", 100, 11, 20, 1);

      engine.archiveContext("chat1");

      const summaries = engine.getSummaries("chat1");
      expect(summaries.length).toBe(0); // all archived

      const wm = engine.getWatermark("chat1");
      expect(wm!.watermarkMessageId).toBe(51); // advanced to latest + 1
    });
  });

  describe("getMinWatermarkForGC", () => {
    it("returns MAX_INT when no watermarks exist", () => {
      expect(engine.getMinWatermarkForGC()).toBe(2147483647);
    });

    it("returns minimum watermark across all chats", () => {
      engine.persistSummary("chat1", "s", 10, 1, 30, 1);
      engine.persistSummary("chat2", "s", 10, 1, 10, 1);
      // chat1 watermark = 31, chat2 watermark = 11
      expect(engine.getMinWatermarkForGC()).toBe(11);
    });
  });

  describe("needsCondensation", () => {
    it("returns false when leaf tokens are low", () => {
      engine.persistSummary("chat1", "short", 100, 1, 5, 1);
      expect(engine.needsCondensation("chat1").needed).toBe(false);
    });

    it("returns true when leaf tokens exceed threshold", () => {
      for (let i = 0; i < 10; i++) {
        engine.persistSummary("chat1", "x".repeat(4000), 1000, i * 5 + 1, (i + 1) * 5, 1);
      }
      expect(engine.needsCondensation("chat1").needed).toBe(true);
    });
  });

  /** #1329 — exclusive upper bound on raw message selection. */
  describe("ContextEngine — beforeMessageId cursor (#1329)", () => {
    let db2: Database.Database;
    let engine2: ContextEngine;

    beforeEach(() => {
      db2 = initializeDatabase(":memory:");
      engine2 = new ContextEngine(db2);
      const insert = db2.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)");
      for (let i = 1; i <= 5; i++) {
        insert.run("u", "c", "user", `msg-${i}`, 1_000_000 + i);
      }
    });

    it("no cursor returns all 5 messages", () => {
      const snap = engine2.buildContext("c");
      expect(snap.messages.map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
    });

    it("cursor = 3 returns only messages with id < 3 (exclusive)", () => {
      const snap = engine2.buildContext("c", { beforeMessageId: 3 });
      expect(snap.messages.map((m) => m.id)).toEqual([1, 2]);
    });

    it("cursor = 1 returns an empty snapshot (everything excluded)", () => {
      const snap = engine2.buildContext("c", { beforeMessageId: 1 });
      expect(snap.messages).toEqual([]);
    });

    it("cursor = 100 (above max) returns all messages", () => {
      const snap = engine2.buildContext("c", { beforeMessageId: 100 });
      expect(snap.messages.map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
    });

    it("cursor composes with watermark: only [wm, before) is eligible", () => {
      db2.prepare("INSERT INTO context_watermarks (chat_id, watermark_message_id, compaction_count) VALUES (?, ?, 1)").run("c", 2);
      const snap = engine2.buildContext("c", { beforeMessageId: 4 });
      expect(snap.messages.map((m) => m.id)).toEqual([2, 3]);
    });

    it("cursor = 0 excludes all messages (id < 0 is never true)", () => {
      const a = engine2.buildContext("c", { beforeMessageId: 0 });
      expect(a.messages).toEqual([]);
    });

    it("undefined cursor / empty options object behaves as no cursor", () => {
      const a = engine2.buildContext("c", { beforeMessageId: undefined });
      const b = engine2.buildContext("c", {});
      expect(a.messages.length).toBe(5);
      expect(b.messages.length).toBe(5);
    });

    it("summaries are unaffected by the upper bound", () => {
      db2.prepare(
        "INSERT INTO context_summaries (chat_id, depth, content, token_estimate, source_message_start, source_message_end, classification, created_at) VALUES (?, 0, ?, 500, 1, 3, 1, ?)",
      ).run("c", "history summary", Date.now());
      const snap = engine2.buildContext("c", { beforeMessageId: 5 });
      expect(snap.summaries.length).toBe(1);
      expect(snap.summaries[0]!.content).toBe("history summary");
    });
  });
});
