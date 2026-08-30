import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderMemory } from "./memory-renderer.js";

describe("ABM-L v2 renderer", () => {
  beforeEach(() => { vi.stubEnv("ABML_VERSION", "v2"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("renders decision with emoji header", () => {
    const result = renderMemory({
      content_en: "Switched from Auth0 to Clerk for pricing and DX",
      memory_type: "decision",
      topic: "coding",
      emotion_tags: "convict",
      confidence: 5,
      date: "M2026-01",
    });
    expect(result).toMatch(/^\[🎯\|💻\|🔥\|5\|M2026-01\]/);
    expect(result).toContain("Switched from Auth0 to Clerk");
  });

  it("renders preference with emoji header", () => {
    const result = renderMemory({
      content_en: "User prefers dark mode and vim keybindings",
      memory_type: "preference",
      topic: "personal",
      emotion_tags: "joy",
      confidence: 4,
      date: "M2026-03",
    });
    expect(result).toMatch(/^\[❤️\|🏠\|😊\|4\|M2026-03\]/);
    expect(result).toContain("dark mode");
  });

  it("renders lesson with frustration", () => {
    const result = renderMemory({
      content_en: "FTS5 breaks on Hungarian — use English for search",
      memory_type: "lesson",
      topic: "coding",
      emotion_tags: "frust",
      confidence: 4,
      date: "M2026-03",
    });
    expect(result).toMatch(/^\[📚\|💻\|😤\|4\|M2026-03\]/);
    expect(result).toContain("FTS5");
  });

  it("uses — for missing emotion", () => {
    const result = renderMemory({
      content_en: "SQLite WAL mode handles concurrent readers",
      memory_type: "fact",
      topic: "coding",
      confidence: 3,
    });
    expect(result).toMatch(/\[📌\|💻\|—\|3\]/);
  });

  it("includes role prefix when provided", () => {
    const result = renderMemory({
      content_en: "How do I fix the FTS issue?",
      memory_type: "fact",
      topic: "coding",
      role: "user",
      confidence: 3,
    });
    expect(result).toMatch(/^\[USER\|📌\|💻\|—\|3\]/);
  });

  it("preserves content without stripping meaning-carrying words", () => {
    const result = renderMemory({
      content_en: "The user has basically just decided that this is very important",
      memory_type: "decision",
      topic: "personal",
      confidence: 3,
    });
    // Content passes through intact (under 120 chars)
    expect(result).toContain("The user has basically just decided that this is very important");
  });

  it("truncates long bodies to 120 chars", () => {
    const longContent = "A".repeat(200);
    const result = renderMemory({
      content_en: longContent,
      memory_type: "fact",
      confidence: 3,
    });
    // Header + space + body (max 120)
    const parts = result.split("] ");
    if (parts[1] === undefined) throw new Error("expected a body part after the header");
    const body = parts[1];
    expect(body.length).toBeLessThanOrEqual(120);
    expect(body).toMatch(/\.\.\.$/);
  });

  it("preserves @entity references", () => {
    const result = renderMemory({
      content_en: "@clerk replaced @auth0 for better pricing",
      memory_type: "decision",
      topic: "coding",
      confidence: 4,
    });
    expect(result).toContain("@clerk");
    expect(result).toContain("@auth0");
  });

  it("falls back gracefully for unknown topic", () => {
    const result = renderMemory({
      content_en: "Something about quantum physics",
      memory_type: "fact",
      topic: "quantum",
      confidence: 3,
    });
    // Unknown topic → no topic emoji, just type + emotion + conf
    expect(result).toMatch(/^\[📌\|—\|3\]/);
  });

  it("handles multiple emotion tags", () => {
    const result = renderMemory({
      content_en: "Mixed feelings about the migration",
      memory_type: "event",
      topic: "coding",
      emotion_tags: "joy,anxious",
      confidence: 3,
    });
    expect(result).toMatch(/😊😰/);
  });
});
