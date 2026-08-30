import { describe, it, expect } from "vitest";
import { applyContextBoost } from "../src/recall-boosts.js";
import type { RecallHit, RecallContext } from "../src/recall-engine.js";

function makeHit(overrides: Partial<RecallHit> = {}): RecallHit {
  return { content: "test", date: "2026-04-28", source: "Sf", score: 1.0, ...overrides };
}

describe("applyContextBoost", () => {
  it("boosts matching hour bucket", () => {
    // Store at 10:00 local → morning bucket. Query with hour=10 → same bucket.
    const now = new Date(); now.setHours(10, 0, 0, 0);
    const hit = makeHit({ createdAt: now.getTime() });
    const ctx: RecallContext = { hour: 10 }; // also morning
    const [result] = applyContextBoost([hit], ctx);
    expect(result!.score).toBeGreaterThan(1.0);
  });

  it("no boost for different hour bucket", () => {
    const now = new Date(); now.setHours(10, 0, 0, 0); // morning
    const hit = makeHit({ createdAt: now.getTime() });
    const ctx: RecallContext = { hour: 20 }; // evening
    const [result] = applyContextBoost([hit], ctx);
    expect(result!.score).toBe(1.0);
  });

  it("boosts matching topic (not general)", () => {
    const hit = makeHit({ topic: "coding" });
    const ctx: RecallContext = { topic: "coding" };
    const [result] = applyContextBoost([hit], ctx);
    expect(result!.score).toBeGreaterThan(1.0);
  });

  it("no boost for topic=general", () => {
    const hit = makeHit({ topic: "general" });
    const ctx: RecallContext = { topic: "general" };
    const [result] = applyContextBoost([hit], ctx);
    expect(result!.score).toBe(1.0);
  });

  it("boosts exact day-of-week match", () => {
    const now = new Date(); const dow = now.getDay();
    const hit = makeHit({ createdAt: now.getTime() });
    const ctx: RecallContext = { dayOfWeek: dow };
    const [result] = applyContextBoost([hit], ctx);
    expect(result!.score).toBeGreaterThan(1.0);
  });

  it("partial boost for same weekday/weekend class", () => {
    // Use a weekday hit, query with a different weekday
    const mon = new Date("2026-04-27T10:00:00"); // Monday local
    const hit = makeHit({ createdAt: mon.getTime() });
    const ctx: RecallContext = { dayOfWeek: 4 }; // Thursday (also weekday)
    const [result] = applyContextBoost([hit], ctx);
    expect(result!.score).toBeGreaterThan(1.0);
    expect(result!.score).toBeLessThan(1.0 + 0.015); // less than full dow boost
  });

  it("no context → no change", () => {
    const hit = makeHit();
    const results = applyContextBoost([hit], {});
    expect(results[0]!.score).toBe(1.0);
  });

  it("total boost bounded — weak candidate with full boost does NOT beat strong un-boosted", () => {
    const now = new Date(); now.setHours(10, 0, 0, 0);
    const weak = makeHit({ score: 0.72, createdAt: now.getTime(), topic: "coding" });
    const strong = makeHit({ score: 1.05 });
    const ctx: RecallContext = { hour: 10, dayOfWeek: now.getDay(), topic: "coding" };
    const [boostedWeak] = applyContextBoost([weak], ctx);
    expect(boostedWeak!.score).toBeLessThan(strong.score);
  });
});
