/**
 * failure-report.test.ts — pins the preserved normal vs catch-up failure
 * extraction policies (#1884). The catch-up mapper is a behavior-preserving
 * move from sleep/catchup.ts; these cases prove the two policies stay
 * distinct after centralization.
 */
import { describe, expect, it } from "vitest";
import { failureFromCatchUpError, failureFromError } from "./failure-report.js";

describe("failure extraction policies", () => {
  it("a generic timeout error maps to timeout on normal, unknown on catch-up", () => {
    const err = new Error("timeout while publishing");
    expect(failureFromError(err, "unknown").cause).toBe("timeout");
    expect(failureFromCatchUpError(err, "unknown")).toMatchObject({ cause: "unknown" });
  });

  it("top-level structured fields are ignored on normal, retained on catch-up", () => {
    const err = { cause: "memory_conflict", detail: "conflict" };
    expect(failureFromError(err, "unknown").cause).toBe("unknown");
    expect(failureFromCatchUpError(err, "unknown")).toMatchObject({
      cause: "memory_conflict",
      detail: "conflict",
    });
  });

  it("a nested failure keeps its cause on both; detail falls back to the message only on catch-up", () => {
    const err = Object.assign(new Error("boom"), { failure: { cause: "memory_conflict" } });
    const normal = failureFromError(err, "unknown");
    expect(normal.cause).toBe("memory_conflict");
    expect(normal.detail).toBeUndefined();
    expect(failureFromCatchUpError(err, "unknown")).toMatchObject({
      cause: "memory_conflict",
      detail: "boom",
    });
  });
});
