/**
 * supervision.test.ts — deterministic supervision policy (#1912).
 *
 * The supervisor makes no model call: classification and recovery decisions
 * are pure functions of normalized evidence and remaining allowances.
 */
import { describe, it, expect } from "vitest";
import {
  classifyExecutionFailure,
  decideRecovery,
  isAdmissionRefusal,
  withExecutionFacts,
  MAX_SUPERVISED_ATTEMPTS,
  SUPERVISION_WAITS_MS,
} from "./supervision.js";

describe("classifyExecutionFailure", () => {
  it("passes through host-supplied structured facts unchanged", () => {
    const facts = classifyExecutionFailure({
      failure: {
        cause: "provider_failed", detail: "x",
        failureClass: "transient", retryAfterMs: 45_000,
        reachedModel: true, effects: "reconcilable", reasonCode: "overload",
      },
    });
    expect(facts).toEqual({
      failureClass: "transient", retryAfterMs: 45_000,
      reachedModel: true, effects: "reconcilable", reasonCode: "overload",
    });
  });

  it("maps 429/503 overload to transient", () => {
    expect(classifyExecutionFailure({ failure: { cause: "provider_failed", detail: "429 rate limited" } }).failureClass).toBe("transient");
    expect(classifyExecutionFailure({ failure: { cause: "provider_failed", detail: "503 Service Unavailable" } }).failureClass).toBe("transient");
  });

  it("maps credits/auth/policy blockers to permanent — no futile waits", () => {
    expect(classifyExecutionFailure({ failure: { cause: "provider_failed", detail: "401 invalid api key" } }).failureClass).toBe("permanent");
    expect(classifyExecutionFailure({ failure: { cause: "provider_failed", detail: "insufficient credits" } }).failureClass).toBe("permanent");
    expect(classifyExecutionFailure({ failure: { cause: "policy_rejected", detail: "x" } }).failureClass).toBe("permanent");
  });

  it("maps cancellation to cancelled", () => {
    expect(classifyExecutionFailure({ failure: { cause: "aborted", detail: "Sleep cancelled" } }).failureClass).toBe("cancelled");
  });

  it("maps admission refusals to unavailable with no model reach", () => {
    const facts = classifyExecutionFailure({
      admissionCode: "provider_unavailable",
      message: "Runtime completion admission refused (provider_unavailable)",
    });
    expect(facts.failureClass).toBe("unavailable");
    expect(facts.reachedModel).toBe(false);
  });

  it("maps timeouts to transient — bounded recovery is justified", () => {
    expect(classifyExecutionFailure({ failure: { cause: "provider_timeout", detail: "provider timed out" } }).failureClass).toBe("transient");
  });

  it("leaves evidence-free failures unknown — never proof of a justified blocker", () => {
    const facts = classifyExecutionFailure({ failure: { cause: "provider_failed", detail: "boom" } });
    expect(facts.failureClass).toBe("unknown");
    expect(facts.effects).toBe("unknown");
  });
});

describe("decideRecovery", () => {
  const cap = 1_000_000 + 3_600_000;
  it("retries transient failures with the scheduled waits", () => {
    const d1 = decideRecovery({ facts: { failureClass: "transient" }, attemptsUsed: 1, nowMs: 1_000_000, capAtMs: cap });
    expect(d1).toEqual({ action: "retry", waitMs: SUPERVISION_WAITS_MS[0], reason: expect.any(String) });
    const d2 = decideRecovery({ facts: { failureClass: "transient" }, attemptsUsed: 2, nowMs: 1_000_000, capAtMs: cap });
    expect(d2).toEqual({ action: "retry", waitMs: SUPERVISION_WAITS_MS[1], reason: expect.any(String) });
  });

  it("stops permanent/cancelled/unavailable without waits", () => {
    for (const failureClass of ["permanent", "cancelled", "unavailable"] as const) {
      const d = decideRecovery({ facts: { failureClass }, attemptsUsed: 1, nowMs: 1_000_000, capAtMs: cap });
      expect(d.action).toBe("stop");
    }
  });

  it("exhausts the allowance exactly once — never reports success", () => {
    const d = decideRecovery({
      facts: { failureClass: "transient" }, attemptsUsed: MAX_SUPERVISED_ATTEMPTS,
      nowMs: 1_000_000, capAtMs: cap,
    });
    expect(d).toMatchObject({ action: "stop", disposition: "exhausted" });
  });

  it("honors a fitting retry-after hint over the scheduled wait", () => {
    const d = decideRecovery({
      facts: { failureClass: "transient", retryAfterMs: 45_000 },
      attemptsUsed: 1, nowMs: 1_000_000, capAtMs: cap,
    });
    expect(d).toEqual({ action: "retry", waitMs: 45_000, reason: expect.any(String) });
  });

  it("falls back to the scheduled wait when the hint does not fit, suspends when nothing fits", () => {
    const tight = 1_000_000 + 20_000 + 30_000 + 30_000 + 5_000; // fits 20s + headroom + window, not 10m
    const d = decideRecovery({
      facts: { failureClass: "transient", retryAfterMs: 600_000 },
      attemptsUsed: 1, nowMs: 1_000_000, capAtMs: tight,
    });
    expect(d).toEqual({ action: "retry", waitMs: SUPERVISION_WAITS_MS[0], reason: expect.any(String) });
    const s = decideRecovery({
      facts: { failureClass: "transient" }, attemptsUsed: 1,
      nowMs: 1_000_000, capAtMs: 1_000_000 + 1_000,
    });
    expect(s.action).toBe("suspend");
  });
});

describe("isAdmissionRefusal / withExecutionFacts", () => {
  it("recognizes broker admission codes through transport wrapping", () => {
    expect(isAdmissionRefusal({ providerCode: "provider_unavailable" })).toBe(true);
    expect(isAdmissionRefusal({ code: "completion_pending" })).toBe(true);
    expect(isAdmissionRefusal(new Error("boom"))).toBe(false);
  });

  it("attaches facts without disturbing cause/detail", () => {
    const out = withExecutionFacts(
      { cause: "provider_failed", detail: "x" },
      { failureClass: "transient", reachedModel: true },
    );
    expect(out).toEqual({ cause: "provider_failed", detail: "x", failureClass: "transient", reachedModel: true });
  });
});
