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

  it("#1928 C7 — rejects a malformed session generation on every lifecycle method", () => {
    const lifecycleMethods: Array<AbmindMethod> = [
      "private.lifecycleStartSession",
      "private.lifecyclePrepareTurn",
      "private.lifecycleCompleteTurn",
      "private.lifecycleStore",
      "private.lifecycleCheckpoint",
      "private.lifecycleObserve",
    ];
    const malformed = [
      { generation: "1" }, { generation: -1 }, { generation: 1.5 }, { generation: null },
    ];
    for (const method of lifecycleMethods) {
      for (const identity of malformed) {
        expect(validatePayload(method, { identity, prompt: "x" }))
          .toBe("identity.generation must be a non-negative integer");
      }
    }
    // Absent and valid generations stay accepted at the boundary; semantic
    // binding is owner-side.
    expect(validatePayload("private.lifecyclePrepareTurn", {
      identity: { generation: 3 }, prompt: "x",
    })).toBeNull();
  });

  it("#1928 C7 — validates context snapshot generation and executionId types", () => {
    const base = {
      identity: { generation: 1 }, prompt: "x",
      context: [{
        text: "prior turn", principal: "u", host: "h", conversation: "c", complete: true,
        generation: 1, executionId: "exec-0",
      }],
    };
    expect(validatePayload("private.lifecyclePrepareTurn", base)).toBeNull();
    for (const generation of [-1, 1.5, "1"]) {
      expect(validatePayload("private.lifecyclePrepareTurn", {
        ...base,
        context: [{ ...base.context[0]!, generation }],
      })).toBe("context entry generation must be a non-negative integer");
    }
    expect(validatePayload("private.lifecyclePrepareTurn", {
      ...base,
      context: [{ ...base.context[0]!, executionId: 42 }],
    })).toBe("context entry executionId must be a string");
  });

  it("#1928 C7 — rejects a malformed session generation on private.recall", () => {
    // The owned core would throw; the RPC boundary must report
    // validation_error so hosts do not retry a caller bug as unavailable.
    const base = { contract: "owned-v1", profile: "recall_fast", rawTurn: "harbor ferry" };
    for (const generation of ["1", -1, 1.5, null]) {
      expect(validatePayload("private.recall", {
        ...base, identity: { principal: "u", generation },
      })).toBe("identity.generation must be a non-negative safe integer");
    }
    expect(validatePayload("private.recall", {
      ...base, identity: { principal: "u", generation: 2 },
    })).toBeNull();
    expect(validatePayload("private.recall", {
      ...base, identity: { principal: "u" },
    })).toBeNull();
  });
});
