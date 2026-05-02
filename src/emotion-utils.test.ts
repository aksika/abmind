// Feature: instant-memory-store, Property 1: Emotion Score Clamping
import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import { clampEmotionScore } from "./emotion-utils.js";

describe("clampEmotionScore — Property 1: Emotion Score Clamping", () => {
  /**
   * Validates: Requirements 7.3, 7.7
   *
   * For any value (integers in [-100, +100], floats, null, undefined, NaN),
   * clampEmotionScore() returns a value in [-5, +5].
   * Integer values in range preserved exactly; outside range clamped to boundary;
   * non-integers default to 0.
   */
  it("always returns a value in [-5, +5] for any input", () => {
    const anyValue = fc.oneof(
      fc.integer({ min: -100, max: 100 }),
      fc.double(),
      fc.constant(undefined),
      fc.constant(null),
      fc.constant(NaN),
    );

    fc.assert(
      fc.property(anyValue, (value) => {
        const result = clampEmotionScore(value);
        expect(result).toBeGreaterThanOrEqual(-5);
        expect(result).toBeLessThanOrEqual(5);
      }),
      { numRuns: 100 },
    );
  });

  it("preserves integer values within [-5, +5] exactly", () => {
    fc.assert(
      fc.property(fc.integer({ min: -5, max: 5 }), (value) => {
        expect(clampEmotionScore(value)).toBe(value);
      }),
      { numRuns: 100 },
    );
  });

  it("clamps integers outside [-5, +5] to the nearest boundary", () => {
    fc.assert(
      fc.property(fc.integer({ min: 6, max: 100 }), (value) => {
        expect(clampEmotionScore(value)).toBe(5);
      }),
      { numRuns: 100 },
    );

    fc.assert(
      fc.property(fc.integer({ min: -100, max: -6 }), (value) => {
        expect(clampEmotionScore(value)).toBe(-5);
      }),
      { numRuns: 100 },
    );
  });

  it("defaults to 0 for non-integer values (floats, null, undefined, NaN)", () => {
    const nonIntegerValue = fc.oneof(
      fc.double().filter((n) => !Number.isInteger(n)),
      fc.constant(undefined),
      fc.constant(null),
      fc.constant(NaN),
    );

    fc.assert(
      fc.property(nonIntegerValue, (value) => {
        expect(clampEmotionScore(value)).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});

describe("emojiToScore", () => {
  // Inline import to avoid changing existing imports
  let emojiToScore: (emoji: string) => number;
  beforeAll(async () => {
    const mod = await import("./emotion-utils.js");
    emojiToScore = mod.emojiToScore;
  });

  it("maps positive emojis to positive scores", () => {
    expect(emojiToScore("❤️")).toBe(4);
    expect(emojiToScore("👍")).toBe(3);
    expect(emojiToScore("😊")).toBe(2);
  });

  it("maps negative emojis to negative scores", () => {
    expect(emojiToScore("👎")).toBe(-3);
    expect(emojiToScore("😡")).toBe(-4);
    expect(emojiToScore("💩")).toBe(-5);
  });

  it("defaults unknown emojis to +1", () => {
    expect(emojiToScore("🦄")).toBe(1);
    expect(emojiToScore("🏠")).toBe(1);
  });
});
