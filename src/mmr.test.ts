import { describe, it, expect } from "vitest";
import { applyMMR } from "./mmr.js";

type Item = { content: string; score: number };

describe("applyMMR", () => {
  it("returns empty array for empty input", () => {
    expect(applyMMR([])).toEqual([]);
  });

  it("returns single item unchanged", () => {
    const items: Item[] = [{ content: "hello world", score: 1.0 }];
    expect(applyMMR(items)).toEqual(items);
  });

  it("first pick is always the highest-scoring result", () => {
    const items: Item[] = [
      { content: "top result about dogs", score: 0.9 },
      { content: "second result about cats", score: 0.7 },
      { content: "third result about birds", score: 0.5 },
    ];
    const result = applyMMR(items, 0.7);
    expect(result[0]!.content).toBe("top result about dogs");
  });

  it("demotes near-duplicate content below diverse content", () => {
    const items: Item[] = [
      { content: "the user likes pizza with extra cheese", score: 0.9 },
      { content: "the user likes pizza with extra cheese and mushrooms", score: 0.85 },
      { content: "the user works with TypeScript in WSL", score: 0.8 },
    ];
    const result = applyMMR(items, 0.7);
    expect(result[0]!.content).toContain("pizza");
    // TypeScript item should be promoted above the near-duplicate pizza item
    expect(result[1]!.content).toContain("TypeScript");
    expect(result[2]!.content).toContain("mushrooms");
  });

  it("preserves all results (no items lost)", () => {
    const items: Item[] = [
      { content: "alpha", score: 0.9 },
      { content: "beta", score: 0.7 },
      { content: "gamma", score: 0.5 },
      { content: "delta", score: 0.3 },
    ];
    const result = applyMMR(items, 0.7);
    expect(result).toHaveLength(4);
    expect(new Set(result.map(r => r.content))).toEqual(new Set(items.map(i => i.content)));
  });

  it("lambda=1.0 preserves original relevance order", () => {
    const items: Item[] = [
      { content: "same words same words", score: 0.9 },
      { content: "same words same words again", score: 0.8 },
      { content: "same words same words too", score: 0.7 },
    ];
    const result = applyMMR(items, 1.0);
    expect(result.map(r => r.score)).toEqual([0.9, 0.8, 0.7]);
  });

  it("lambda=0.0 maximizes diversity", () => {
    const items: Item[] = [
      { content: "the quick brown fox jumps", score: 0.9 },
      { content: "the quick brown fox leaps", score: 0.85 },
      { content: "completely different unrelated content here", score: 0.5 },
    ];
    const result = applyMMR(items, 0.0);
    expect(result[0]!.score).toBe(0.9);
    // Diverse item should be second despite lower score
    expect(result[1]!.content).toContain("completely different");
  });

  it("does not mutate the input array", () => {
    const items: Item[] = [
      { content: "one", score: 0.9 },
      { content: "two", score: 0.7 },
    ];
    const copy = [...items];
    applyMMR(items, 0.7);
    expect(items).toEqual(copy);
  });
});
