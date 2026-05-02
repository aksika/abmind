import { describe, it, expect } from "vitest";
import { buildArc } from "./emotion-arc.js";
import { checkContradiction } from "./contradiction-checker.js";

describe("emotion-arc", () => {
  it("returns stable for empty input", () => {
    expect(buildArc([])).toEqual({ tags: [], direction: "stable", symbol: "—" });
  });

  it("detects rising arc", () => {
    const memories = [
      { emotion_tags: "fear", created_at: 1000 },
      { emotion_tags: "doubt", created_at: 2000 },
      { emotion_tags: "hope", created_at: 3000 },
      { emotion_tags: "hope", created_at: 4000 },
      { emotion_tags: "relief", created_at: 5000 },
      { emotion_tags: "pride", created_at: 6000 },
    ];
    const arc = buildArc(memories);
    expect(arc.direction).toBe("rising");
    expect(arc.symbol).toBe("↑");
  });

  it("detects falling arc", () => {
    const memories = [
      { emotion_tags: "joy", created_at: 1000 },
      { emotion_tags: "joy", created_at: 2000 },
      { emotion_tags: "doubt", created_at: 3000 },
      { emotion_tags: "frustration", created_at: 4000 },
      { emotion_tags: "frustration", created_at: 5000 },
      { emotion_tags: "anger", created_at: 6000 },
    ];
    const arc = buildArc(memories);
    expect(arc.direction).toBe("falling");
    expect(arc.symbol).toBe("↓");
  });

  it("detects volatile arc", () => {
    const memories = [
      { emotion_tags: "joy", created_at: 1000 },
      { emotion_tags: "anger", created_at: 2000 },
      { emotion_tags: "relief", created_at: 3000 },
      { emotion_tags: "fear", created_at: 4000 },
      { emotion_tags: "pride", created_at: 5000 },
      { emotion_tags: "grief", created_at: 6000 },
    ];
    const arc = buildArc(memories);
    expect(arc.direction).toBe("volatile");
    expect(arc.symbol).toBe("↕");
  });

  it("collects unique tags", () => {
    const memories = [
      { emotion_tags: "joy,trust", created_at: 1000 },
      { emotion_tags: "joy,pride", created_at: 2000 },
    ];
    const arc = buildArc(memories);
    expect(arc.tags).toContain("joy");
    expect(arc.tags).toContain("trust");
    expect(arc.tags).toContain("pride");
    expect(new Set(arc.tags).size).toBe(arc.tags.length); // no dupes
  });
});

describe("contradiction-checker", () => {
  const core = [
    { id: 1, content_en: "We use Auth0 for authentication", topic: "coding" },
    { id: 2, content_en: "The database runs on PostgreSQL", topic: "coding" },
    { id: 3, content_en: "User prefers dark mode", topic: "personal" },
  ];

  it("detects contradiction with negation", () => {
    const hit = checkContradiction(
      "We no longer use Auth0, switched to Clerk for authentication",
      "coding", core,
    );
    expect(hit).not.toBeNull();
    expect(hit!.existingId).toBe(1);
  });

  it("returns null for non-contradicting addition", () => {
    const hit = checkContradiction(
      "Auth0 pricing is $50 per month for authentication",
      "coding", core,
    );
    expect(hit).toBeNull();
  });

  it("returns null for different topic", () => {
    const hit = checkContradiction(
      "We replaced Auth0 with something else",
      "personal", core, // different topic
    );
    expect(hit).toBeNull();
  });

  it("returns null for unrelated content", () => {
    const hit = checkContradiction(
      "The weather is nice today",
      "coding", core,
    );
    expect(hit).toBeNull();
  });
});
