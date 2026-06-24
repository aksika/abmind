import { describe, it, expect } from "vitest";
import { LlmRefinementCache } from "./tier-llm-refinement.js";

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
});
