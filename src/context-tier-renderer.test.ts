import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import { ContextEngine } from "./context-engine.js";
import { renderForContext, renderMiddleTurn, determineTier } from "./context-tier-renderer.js";
import { _resetAbmindEnv } from "./env-schema.js";

describe("context-tier-renderer", () => {
  let db: Database.Database;
  let engine: ContextEngine;

  beforeEach(() => {
    db = initializeDatabase(":memory:");
    engine = new ContextEngine(db);
    process.env.ABML_VERSION = "v1";
    _resetAbmindEnv();
  });

  afterEach(() => {
    db.close();
    delete process.env.ABML_VERSION;
    delete process.env.CONTEXT_TIER_ENABLED;
    delete process.env.CONTEXT_TIER_TAIL;
    delete process.env.CONTEXT_TIER_MIDDLE;
    _resetAbmindEnv();
  });

  describe("determineTier", () => {
    it("classifies position-based tiers", () => {
      // tailSize=20, middleSize=50
      expect(determineTier(0, 20, 50)).toBe("tail");   // newest
      expect(determineTier(19, 20, 50)).toBe("tail");  // last of tail
      expect(determineTier(20, 20, 50)).toBe("middle"); // first of middle
      expect(determineTier(69, 20, 50)).toBe("middle"); // last of middle
      expect(determineTier(70, 20, 50)).toBe("head");  // head
      expect(determineTier(500, 20, 50)).toBe("head"); // way old
    });
  });

  describe("renderMiddleTurn (pure function)", () => {
    it("renders a user turn with hints as v1 ABM-L with role prefix", () => {
      const result = renderMiddleTurn({
        id: 1,
        role: "user",
        content: "I keep getting the FTS issue again.",
        timestamp: Date.parse("2026-04-15"),
        type_hint: "L",
        topic_hint: "coding",
        emotion_hint: "frust",
      });
      // Should start with [USER|L|coding|...]
      expect(result).toMatch(/^\[USER\|L\|coding\|/);
      expect(result).toContain("FTS issue");
    });

    it("renders an assistant turn with ASSISTANT prefix", () => {
      const result = renderMiddleTurn({
        id: 2,
        role: "assistant",
        content: "Let me check the config.",
        timestamp: Date.parse("2026-04-15"),
        type_hint: "D",
        topic_hint: null,
        emotion_hint: null,
      });
      expect(result).toMatch(/^\[ASSISTANT\|D\|/);
    });

    it("falls back to defaults when hints are null", () => {
      const result = renderMiddleTurn({
        id: 3,
        role: "user",
        content: "Hello.",
        timestamp: Date.parse("2026-04-15"),
        type_hint: null,
        topic_hint: null,
        emotion_hint: null,
      });
      // type defaults to F (fact), topic to general (not emitted in v1 when "general")
      expect(result).toMatch(/^\[USER\|F\|/);
    });
  });

  describe("renderForContext", () => {
    function insertMessage(chatId: string, role: string, content: string, ts: number, hints?: { type: string | null; topic: string | null; emotion: string | null }): number {
      const h = hints ?? { type: null, topic: null, emotion: null };
      return Number(
        db.prepare(
          "INSERT INTO messages (user_id, session_id, role, content, timestamp, type_hint, topic_hint, emotion_hint) VALUES ('user1', ?, ?, ?, ?, ?, ?, ?)",
        ).run(chatId, role, content, ts, h.type, h.topic, h.emotion).lastInsertRowid,
      );
    }

    it("assembles three tiers correctly", () => {
      process.env.CONTEXT_TIER_TAIL = "2";
      process.env.CONTEXT_TIER_MIDDLE = "3";
      _resetAbmindEnv();

      const chatId = "test";
      const now = Date.now();
      // 7 messages, oldest first. With tail=2, middle=3:
      // - positions from end: msg7=0, msg6=1 → tail (verbatim)
      // - msg5=2, msg4=3, msg3=4 → middle (ABM-L)
      // - msg2=5, msg1=6 → head (but no summary → they'd show in context too; skipped per renderer)
      insertMessage(chatId, "user", "oldest msg 1", now - 7000);
      insertMessage(chatId, "assistant", "msg 2", now - 6000);
      insertMessage(chatId, "user", "msg 3", now - 5000, { type: "Q", topic: "coding", emotion: null });
      insertMessage(chatId, "assistant", "msg 4", now - 4000, { type: "D", topic: null, emotion: null });
      insertMessage(chatId, "user", "msg 5", now - 3000, { type: "O", topic: null, emotion: null });
      insertMessage(chatId, "assistant", "recent msg 6", now - 2000);
      insertMessage(chatId, "user", "newest msg 7", now - 1000);

      const result = renderForContext(db, engine, chatId);
      expect(result.tierBreakdown.tailCount).toBe(2);
      expect(result.tierBreakdown.middleCount).toBe(3);
      expect(result.tierBreakdown.headCount).toBe(0); // no summaries yet

      // Tail messages should be verbatim
      const tailContents = result.messages.slice(-2).map(m => m.content);
      expect(tailContents).toContain("recent msg 6");
      expect(tailContents).toContain("newest msg 7");

      // Middle messages should have ABM-L brackets
      const middleMessages = result.messages.slice(-5, -2);
      expect(middleMessages.every(m => m.content.startsWith("["))).toBe(true);
    });

    it("falls back to binary assembly when CONTEXT_TIER_ENABLED=false", () => {
      process.env.CONTEXT_TIER_ENABLED = "false";
      _resetAbmindEnv();

      const chatId = "test";
      const now = Date.now();
      insertMessage(chatId, "user", "m1", now - 2000);
      insertMessage(chatId, "assistant", "m2", now - 1000);

      const result = renderForContext(db, engine, chatId);
      // All messages should be verbatim, no middle tier
      expect(result.tierBreakdown.middleCount).toBe(0);
      expect(result.tierBreakdown.tailCount).toBe(2);
      expect(result.messages[0]?.content).toBe("m1");
      expect(result.messages[1]?.content).toBe("m2");
    });
  });
});
