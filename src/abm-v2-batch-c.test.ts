import { describe, it, expect } from "vitest";
import { buildArc } from "./emotion-arc.js";

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

