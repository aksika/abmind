import { describe, it, expect } from "vitest";
import { estimateTokens, chunkMessages } from "./sleep-daily-summary.js";

describe("estimateTokens", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens("hello")).toBe(2);
    expect(estimateTokens("a".repeat(100))).toBe(25);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("chunkMessages", () => {
  const makeMsg = (content: string, id = 1) => ({
    id, role: "user", content, timestamp: Date.now(),
  });

  it("returns single batch when all fit", () => {
    const msgs = [makeMsg("hello"), makeMsg("world")];
    const batches = chunkMessages(msgs, 10000);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it("splits into multiple batches when over budget", () => {
    // Realistic messages with spaces/punctuation (not stripped as binary)
    const text = "The user asked about deploying the new version to production. We discussed the rollback strategy and decided to use blue-green deployment.";
    const msgs = Array.from({ length: 10 }, (_, i) => makeMsg(text.repeat(3), i));
    // Each msg: ~420 chars = ~105 tokens * 1.2 = ~126. Budget 200 → ~1-2 per batch
    const batches = chunkMessages(msgs, 200);
    expect(batches.length).toBeGreaterThan(1);
    const total = batches.reduce((sum, b) => sum + b.length, 0);
    expect(total).toBe(10);
  });

  it("returns empty array for no messages", () => {
    expect(chunkMessages([], 10000)).toEqual([]);
  });
});
