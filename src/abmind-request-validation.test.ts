import { describe, it, expect } from "vitest";
import { METHOD_REGISTRY } from "./abmind-protocol.js";
import type { AbmindMethod } from "./abmind-protocol.js";
import { validatePayload } from "./abmind-request-validation.js";

// #1885: the per-method validator map replaced the validatePayload switch.
// These pin the two failure modes specific to that refactor: a method left
// without a validator (caught at compile time too, but this proves the
// runtime wiring), and a pass-through no-op slot filled with new field
// checks that would reject payloads live callers send today.
describe("abmind-request-validation contract preservation", () => {
  it("resolves every registry method to a validator without throwing", () => {
    for (const method of Object.keys(METHOD_REGISTRY) as AbmindMethod[]) {
      const result = validatePayload(method, {});
      expect(result === null || typeof result === "string").toBe(true);
    }
  });

  it("still accepts payloads the old fall-through accepted", () => {
    const accepted: Array<[AbmindMethod, unknown]> = [
      ["system.negotiate", {}],
      ["sleep.start", { mode: "manual", level: "deep", fresh: true }],
      ["sleep.events", { afterSeq: 0 }],
      ["sleep.runtime.fail", { leaseId: "l", completionId: "c", code: "x" }],
      ["operational.submitDraft", {}],
      ["operational.recall", {}],
      ["private.rebuildFts", {}],
      ["private.getRecentConversation", { userId: "u", since: 0, limit: 10 }],
      ["private.getRuntimeStatus", {}],
      // Lifecycle completeTurn has no shape rules beyond the identity object.
      ["private.lifecycleCompleteTurn", { identity: {} }],
    ];
    for (const [method, payload] of accepted) {
      expect(validatePayload(method, payload)).toBeNull();
    }
  });

  it("still rejects what the old rules rejected", () => {
    // Object-shape gate for private./operational. methods.
    expect(validatePayload("private.recall", "x")).toBe("Payload must be an object");
    expect(validatePayload("private.lifecycleObserve", { identity: {} })).toBe(
      "eventId must be a non-empty string",
    );
    // Per-method rules.
    expect(validatePayload("operator.repair", { action: "nonsense" })).toBe(
      "unknown repair action: nonsense",
    );
    expect(validatePayload("private.dreamQuestions.list", { userId: "u", limit: 51 })).toBe(
      "limit must be a safe integer within 1-50",
    );
    expect(validatePayload("private.embed", { texts: [] })).toBe(
      "texts must contain 1-100 strings of at most 8192 characters",
    );
  });

  // Review finding (2026-10-02): the old switch grouped all seven lifecycle
  // methods in one identity-gated case; rebuilding the map by hand dropped the
  // gate for completeTurn, which has no other rules. Table-drive all seven so
  // any dropped identity gate fails here.
  it("requires an identity object for every lifecycle method", () => {
    const lifecycleMethods: Array<AbmindMethod> = [
      "private.lifecycleStartSession",
      "private.lifecyclePrepareTurn",
      "private.lifecycleCompleteTurn",
      "private.lifecycleRecall",
      "private.lifecycleStore",
      "private.lifecycleCheckpoint",
      "private.lifecycleObserve",
    ];
    for (const method of lifecycleMethods) {
      for (const payload of [{}, { identity: null }, { identity: "x" }]) {
        expect(validatePayload(method, payload)).toBe("identity must be an object");
      }
    }
  });
});
