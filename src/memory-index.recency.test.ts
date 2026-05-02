import { describe, it, expect } from "vitest";
import { recencyFactor } from "./memory-index.js";

const DAY_MS = 24 * 3600000;

describe("recencyFactor", () => {
  it("returns ~1.0 for fresh memories with no emotion", () => {
    const factor = recencyFactor(Date.now() - DAY_MS, 0);
    expect(factor).toBeGreaterThan(0.99);
    expect(factor).toBeLessThanOrEqual(1.01);
  });

  it("decays over time", () => {
    const fresh = recencyFactor(Date.now() - DAY_MS, 0);
    const halfYear = recencyFactor(Date.now() - 180 * DAY_MS, 0);
    const oneYear = recencyFactor(Date.now() - 365 * DAY_MS, 0);
    expect(fresh).toBeGreaterThan(halfYear);
    expect(halfYear).toBeGreaterThan(oneYear);
  });

  it("has a floor — never goes to zero", () => {
    const ancient = recencyFactor(Date.now() - 1000 * DAY_MS, 0);
    expect(ancient).toBeGreaterThanOrEqual(0.3);
  });

  it("emotion boosts resist decay", () => {
    const ts = Date.now() - 180 * DAY_MS;
    const neutral = recencyFactor(ts, 0);
    const emotional = recencyFactor(ts, 5);
    expect(emotional).toBeGreaterThan(neutral);
    expect(emotional / neutral).toBeCloseTo(1.5, 1); // +5 emotion = 1.5x boost
  });

  it("negative emotion also boosts (absolute value)", () => {
    const ts = Date.now() - 90 * DAY_MS;
    const positive = recencyFactor(ts, 3);
    const negative = recencyFactor(ts, -3);
    expect(positive).toBeCloseTo(negative, 5);
  });
});
