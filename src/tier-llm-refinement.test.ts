import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import { ContextEngine } from "./context-engine.js";
import {
  renderForContext,
  refineMiddleTierBatch,
  _getLlmCache,
} from "./context-tier-renderer.js";
import { LlmRefinementCache } from "./tier-llm-refinement.js";
import { _resetAbmindEnv } from "./env-schema.js";

describe("tier-llm-refinement (Phase 2)", () => {
  describe("LlmRefinementCache", () => {
    it("stores and retrieves entries", () => {
      const cache = new LlmRefinementCache(100);
      cache.set("chat1", 42, "[USER|L|coding|3|M2026-04] refined");
      expect(cache.get("chat1", 42)).toBe("[USER|L|coding|3|M2026-04] refined");
      expect(cache.get("chat1", 43)).toBeNull();
    });

    it("evicts LRU when over cap", () => {
      const cache = new LlmRefinementCache(3);
      cache.set("c", 1, "a");
      cache.set("c", 2, "b");
      cache.set("c", 3, "c");
      // 4th entry evicts oldest (id=1)
      cache.set("c", 4, "d");
      expect(cache.get("c", 1)).toBeNull();
      expect(cache.get("c", 2)).toBe("b");
      expect(cache.get("c", 4)).toBe("d");
    });

    it("evictChatRange removes only specified range", () => {
      const cache = new LlmRefinementCache(100);
      cache.set("c1", 10, "a");
      cache.set("c1", 20, "b");
      cache.set("c1", 30, "c");
      cache.set("c2", 15, "d"); // different chat — untouched
      const evicted = cache.evictChatRange("c1", 15, 25);
      expect(evicted).toBe(1); // only id=20 is in [15,25]
      expect(cache.get("c1", 10)).toBe("a");
      expect(cache.get("c1", 20)).toBeNull();
      expect(cache.get("c1", 30)).toBe("c");
      expect(cache.get("c2", 15)).toBe("d");
    });
  });

  describe("refineMiddleTierBatch", () => {
    let db: Database.Database;
    let engine: ContextEngine;

    beforeEach(() => {
      db = initializeDatabase(":memory:");
      engine = new ContextEngine(db);
      _getLlmCache().clear();
      process.env.ABML_VERSION = "v1";
      process.env.CONTEXT_TIER_ENABLED = "true";
      process.env.CONTEXT_TIER_TAIL = "2";
      process.env.CONTEXT_TIER_MIDDLE = "3";
      _resetAbmindEnv();
    });

    afterEach(() => {
      db.close();
      delete process.env.ABML_VERSION;
      delete process.env.CONTEXT_TIER_ENABLED;
      delete process.env.CONTEXT_TIER_TAIL;
      delete process.env.CONTEXT_TIER_MIDDLE;
      delete process.env.COMPACTION_LLM_ENABLED;
      _resetAbmindEnv();
    });

    function insertMessage(chatId: string, role: string, content: string, ts: number): number {
      return Number(
        db.prepare(
          "INSERT INTO messages (user_id, session_id, role, content, timestamp, type_hint, topic_hint, emotion_hint) VALUES ('u1', ?, ?, ?, ?, 'O', 'coding', null)",
        ).run(chatId, role, content, ts).lastInsertRowid,
      );
    }

    it("does nothing when COMPACTION_LLM_ENABLED=false", async () => {
      process.env.COMPACTION_LLM_ENABLED = "false";
      _resetAbmindEnv();

      const chatId = "c1";
      const now = Date.now();
      for (let i = 0; i < 7; i++) insertMessage(chatId, i % 2 ? "assistant" : "user", `msg ${i}`, now - (7 - i) * 1000);

      let called = false;
      const llm = async () => { called = true; return "x"; };
      const result = await refineMiddleTierBatch(db, engine, chatId, llm);

      expect(result.refined).toBe(0);
      expect(called).toBe(false);
    });

    it("refines uncached middle messages when flag true", async () => {
      process.env.COMPACTION_LLM_ENABLED = "true";
      _resetAbmindEnv();

      const chatId = "c1";
      const now = Date.now();
      for (let i = 0; i < 7; i++) insertMessage(chatId, i % 2 ? "assistant" : "user", `msg ${i}`, now - (7 - i) * 1000);

      const llm = async () => {
        // Return 3 lines (matching the 3 middle messages)
        return [
          "[USER|O|coding|3|M2026-04] refined msg A",
          "[ASSISTANT|O|coding|3|M2026-04] refined msg B",
          "[USER|O|coding|3|M2026-04] refined msg C",
        ].join("\n");
      };

      const result = await refineMiddleTierBatch(db, engine, chatId, llm);
      expect(result.refined).toBe(3);
      expect(result.skipped).toBe(0);

      // Next assembly should use the cached refined strings
      const tiered = renderForContext(db, engine, chatId);
      const middleMessages = tiered.messages.slice(-5, -2);
      expect(middleMessages.map(m => m.content)).toEqual([
        "[USER|O|coding|3|M2026-04] refined msg A",
        "[ASSISTANT|O|coding|3|M2026-04] refined msg B",
        "[USER|O|coding|3|M2026-04] refined msg C",
      ]);
    });

    it("falls back to heuristic when LLM throws", async () => {
      process.env.COMPACTION_LLM_ENABLED = "true";
      _resetAbmindEnv();

      const chatId = "c1";
      const now = Date.now();
      for (let i = 0; i < 7; i++) insertMessage(chatId, i % 2 ? "assistant" : "user", `msg ${i}`, now - (7 - i) * 1000);

      const llm = async () => { throw new Error("model down"); };
      const result = await refineMiddleTierBatch(db, engine, chatId, llm);
      expect(result.refined).toBe(0);
      expect(result.skipped).toBe(3);

      // Assembly should still work, using heuristic
      const tiered = renderForContext(db, engine, chatId);
      expect(tiered.tierBreakdown.middleCount).toBe(3);
      // Middle messages should be heuristic-rendered (start with [USER|O| or [ASSISTANT|O|)
      const middleMessages = tiered.messages.slice(-5, -2);
      expect(middleMessages.every(m => m.content.startsWith("["))).toBe(true);
    });

    it("skips already-cached messages on subsequent runs", async () => {
      process.env.COMPACTION_LLM_ENABLED = "true";
      _resetAbmindEnv();

      const chatId = "c1";
      const now = Date.now();
      for (let i = 0; i < 7; i++) insertMessage(chatId, i % 2 ? "assistant" : "user", `msg ${i}`, now - (7 - i) * 1000);

      let callCount = 0;
      const llm = async () => {
        callCount++;
        return [
          "[USER|O|coding|3|M2026-04] a",
          "[ASSISTANT|O|coding|3|M2026-04] b",
          "[USER|O|coding|3|M2026-04] c",
        ].join("\n");
      };

      await refineMiddleTierBatch(db, engine, chatId, llm);
      await refineMiddleTierBatch(db, engine, chatId, llm);

      // Second call should have nothing to refine
      expect(callCount).toBe(1);
    });
  });
});
