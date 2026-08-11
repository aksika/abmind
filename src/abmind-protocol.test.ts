import { describe, it, expect } from "vitest";
import {
  ABMIND_PROTOCOL_VERSION, METHOD_REGISTRY, REQUEST_ID_MAX, IDEMPOTENCY_KEY_MAX,
  PRINCIPAL_ID_MAX, REQUEST_MAX_BYTES, RESPONSE_MAX_BYTES,
  canonicalPayloadHash, isIdempotencyRequired, methodDomain,
} from "./abmind-protocol.js";

describe("abmind-protocol", () => {
  it("defines protocol version 1", () => {
    expect(ABMIND_PROTOCOL_VERSION).toBe(1);
  });

  it("registers all expected methods", () => {
    const methods = Object.keys(METHOD_REGISTRY);
    expect(methods).toContain("system.negotiate");
    expect(methods).toContain("system.health");
    expect(methods).toContain("system.status");
    expect(methods).toContain("system.capabilities");
    expect(methods).toContain("private.recall");
    expect(methods).toContain("private.instantStore");
    expect(methods).toContain("private.edit");
    expect(methods).toContain("private.reclassify");
    expect(methods).toContain("private.adjustRelevance");
    expect(methods).toContain("private.merge");
    expect(methods).toContain("private.cascadeDelete");
    expect(methods).toContain("private.rebuildFts");
    expect(methods).toContain("private.recordMessage");
    expect(methods).toContain("private.getRecentConversation");
    expect(methods).toContain("private.getRuntimeStatus");
    expect(methods).toContain("private.getCoreKnowledge");
    expect(methods).toContain("private.recordFeedback");
    expect(methods).toContain("private.projectConversationContext");
    expect(methods).toContain("operational.submitDraft");
    expect(methods).toContain("operational.listDrafts");
    expect(methods).toContain("operational.getMemory");
    expect(methods).toContain("operational.getHistory");
    expect(methods).toContain("operational.promoteDraft");
    expect(methods).toContain("operational.rejectDraft");
    expect(methods).toContain("operational.revise");
    expect(methods).toContain("operational.retire");
    expect(methods).toContain("operational.recall");
    expect(methods).toContain("sleep.start");
    expect(methods).toContain("sleep.status");
    expect(methods).toContain("sleep.resume");
    expect(methods).toContain("sleep.cancel");
    expect(methods).toContain("sleep.events");
    expect(methods).toContain("sleep.runtime.open");
    expect(methods).toContain("sleep.runtime.next");
    expect(methods).toContain("sleep.runtime.complete");
    expect(methods).toContain("sleep.runtime.fail");
    expect(methods).toContain("sleep.runtime.close");
    expect(methods.length).toBe(43);
  });

  it("assigns correct domains to system methods", () => {
    expect(methodDomain("system.negotiate")).toBe("system");
    expect(methodDomain("system.health")).toBe("system");
    expect(methodDomain("system.capabilities")).toBe("system");
  });

  it("assigns private domain to private methods", () => {
    expect(methodDomain("private.recall")).toBe("private");
    expect(methodDomain("private.instantStore")).toBe("private");
    expect(methodDomain("private.edit")).toBe("private");
  });

  it("assigns operational domain to operational methods", () => {
    expect(methodDomain("operational.submitDraft")).toBe("operational");
    expect(methodDomain("operational.listDrafts")).toBe("operational");
    expect(methodDomain("operational.recall")).toBe("operational");
  });

  it("assigns operator domain to rebuildFts", () => {
    expect(methodDomain("private.rebuildFts")).toBe("operator");
  });

  it("identifies mutating methods", () => {
    expect(isIdempotencyRequired("system.negotiate")).toBe(false);
    expect(isIdempotencyRequired("system.health")).toBe(false);
    expect(isIdempotencyRequired("private.recall")).toBe(false);
    expect(isIdempotencyRequired("private.instantStore")).toBe(true);
    expect(isIdempotencyRequired("private.edit")).toBe(true);
    expect(isIdempotencyRequired("private.merge")).toBe(true);
    expect(isIdempotencyRequired("private.cascadeDelete")).toBe(true);
    expect(isIdempotencyRequired("operational.submitDraft")).toBe(true);
    expect(isIdempotencyRequired("operational.promoteDraft")).toBe(true);
    expect(isIdempotencyRequired("operational.listDrafts")).toBe(false);
    expect(isIdempotencyRequired("sleep.start")).toBe(true);
    expect(isIdempotencyRequired("sleep.status")).toBe(false);
    expect(isIdempotencyRequired("sleep.events")).toBe(false);
    expect(isIdempotencyRequired("sleep.runtime.complete")).toBe(true);
    expect(isIdempotencyRequired("operational.getMemory")).toBe(false);
    expect(isIdempotencyRequired("operational.revise")).toBe(true);
    expect(isIdempotencyRequired("operational.retire")).toBe(true);
  });

  it("returns false for unknown methods in isIdempotencyRequired", () => {
    expect(isIdempotencyRequired("unknown.method")).toBe(false);
  });

  it("returns undefined for unknown methods in methodDomain", () => {
    expect(methodDomain("unknown.method")).toBeUndefined();
  });

  it("provides max I/O bounds for every registered method", () => {
    for (const [method, entry] of Object.entries(METHOD_REGISTRY)) {
      expect(entry.maxInputBytes).toBeGreaterThan(0);
      expect(entry.maxOutputBytes).toBeGreaterThan(0);
      expect(["system", "private", "operational", "operator"]).toContain(entry.domain);
      expect(["read", "mutate"]).toContain(entry.mutation);
    }
  });

  it("rebuildFts has capability set", () => {
    expect(METHOD_REGISTRY["private.rebuildFts"].capability).toBe("rebuild_fts");
  });

  it("classifies cascadeDelete as owner-cascade-delete (#1511)", () => {
    expect(METHOD_REGISTRY["private.cascadeDelete"].safety).toBe("owner-cascade-delete");
    expect(METHOD_REGISTRY["private.cascadeDelete"].mutation).toBe("mutate");
  });

  it("canonicalPayloadHash is deterministic", () => {
    const payload = { foo: "bar", num: 42 };
    const h1 = canonicalPayloadHash(1, "test.method", payload);
    const h2 = canonicalPayloadHash(1, "test.method", payload);
    expect(h1).toBe(h2);
  });

  it("canonicalPayloadHash changes when payload changes", () => {
    const h1 = canonicalPayloadHash(1, "test.method", { a: 1 });
    const h2 = canonicalPayloadHash(1, "test.method", { a: 2 });
    expect(h1).not.toBe(h2);
  });

  it("canonicalPayloadHash changes when version changes", () => {
    const h1 = canonicalPayloadHash(1, "test.method", { a: 1 });
    const h2 = canonicalPayloadHash(2, "test.method", { a: 1 });
    expect(h1).not.toBe(h2);
  });

  it("canonicalPayloadHash is key-order independent", () => {
    const h1 = canonicalPayloadHash(1, "m", { b: 2, a: 1 });
    const h2 = canonicalPayloadHash(1, "m", { a: 1, b: 2 });
    expect(h1).toBe(h2);
  });

  it("canonicalPayloadHash sorts object keys", () => {
    const hash = canonicalPayloadHash(1, "m", { z: 1, a: 2 });
    expect(hash.length).toBe(64); // sha256 hex
  });

  it("canonicalPayloadHash rejects non-finite numbers", () => {
    expect(() => canonicalPayloadHash(1, "m", { x: NaN })).toThrow("Non-finite");
    expect(() => canonicalPayloadHash(1, "m", { x: Infinity })).toThrow("Non-finite");
  });

  it("has correct bound constants", () => {
    expect(REQUEST_ID_MAX).toBe(128);
    expect(IDEMPOTENCY_KEY_MAX).toBe(128);
    expect(PRINCIPAL_ID_MAX).toBe(256);
    expect(REQUEST_MAX_BYTES).toBe(262144);
    expect(RESPONSE_MAX_BYTES).toBe(524288);
  });
});
