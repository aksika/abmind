/**
 * failure-report.test.ts — pins the normal failure extraction policy.
 * #1905 removed the catch-up mapper with its coordinator.
 */
import { describe, expect, it } from "vitest";
import { failureFromError } from "./failure-report.js";

describe("failure extraction policy", () => {
  it("a generic timeout error maps to timeout", () => {
    const err = new Error("timeout while publishing");
    expect(failureFromError(err, "unknown").cause).toBe("timeout");
  });

  it("top-level structured fields without a failure envelope are ignored", () => {
    const err = { cause: "memory_conflict", detail: "conflict" };
    expect(failureFromError(err, "unknown").cause).toBe("unknown");
  });

  it("a nested failure keeps its cause", () => {
    const err = Object.assign(new Error("boom"), { failure: { cause: "memory_conflict" } });
    const normal = failureFromError(err, "unknown");
    expect(normal.cause).toBe("memory_conflict");
    expect(normal.detail).toBeUndefined();
  });
});
