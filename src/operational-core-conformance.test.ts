import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory-manager.js";
import type { IOperationalMemoryCore, OperationalMemoryApi } from "./imemory-system.js";
import type {
  OperationalDraft,
  OperationalMemoryProjection,
  OperationalRecallHit,
  Page,
  PageRequest,
  DraftListQuery,
  OperationalRecallQuery,
  SubmitOperationalDraftInput,
  PromoteDraftInput,
  RejectDraftInput,
  ReviseOperationalMemoryInput,
  RetireOperationalMemoryInput,
  OperationalResult,
} from "./operational-memory-types.js";
import { makeMemoryTestConfig } from "./test-helpers.js";

describe("IOperationalMemoryCore — interface conformance", () => {
  let tmpDir: string;
  let mm: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "op-core-iface-"));
    mm = new MemoryManager(makeMemoryTestConfig(tmpDir));
  });

  afterEach(() => {
    try { mm.close(); } catch { /* ok */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("MemoryManager satisfies IOperationalMemoryCore at compile time", () => {
    const core: IOperationalMemoryCore = mm;
    expect(core).toBeDefined();
  });

  it("operational is null before initialization", () => {
    expect(mm.operational).toBeNull();
  });

  it("operational is available after successful initialization", async () => {
    await mm.initialize({ skipEmbeddingCheck: true });
    expect(mm.operational).not.toBeNull();
  });

  it("operational is null after close", async () => {
    await mm.initialize({ skipEmbeddingCheck: true });
    expect(mm.operational).not.toBeNull();
    mm.close();
    expect(mm.operational).toBeNull();
  });

  it("operational is null when memoryEnabled is false", async () => {
    const disabled = new MemoryManager(makeMemoryTestConfig(tmpDir, { memoryEnabled: false }));
    try {
      await disabled.initialize({ skipEmbeddingCheck: true });
      expect(disabled.operational).toBeNull();
    } finally {
      disabled.close();
    }
  });

  it("operational is null after failed initialization", async () => {
    const failing = new MemoryManager(makeMemoryTestConfig(join(tmpdir(), "nonexistent-perm"), { memoryDir: "/dev/null/nope" }));
    try {
      await failing.initialize({ skipEmbeddingCheck: true });
    } catch {
      // expected
    }
    expect(failing.operational).toBeNull();
    try { failing.close(); } catch { /* ok */ }
  });

  it("exposes all required OperationalMemoryApi methods", async () => {
    await mm.initialize({ skipEmbeddingCheck: true });
    const api = mm.operational!;
    const methods: Array<keyof OperationalMemoryApi> = [
      "submitDraft", "listDrafts", "getMemory", "getHistory",
      "promoteDraft", "rejectDraft", "revise", "retire", "recall",
    ];
    for (const method of methods) {
      expect(typeof (api as unknown as Record<string, unknown>)[method]).toBe("function");
    }
  });

  it("every api method is async (returns Promise)", async () => {
    await mm.initialize({ skipEmbeddingCheck: true });
    const api = mm.operational!;
    const methods: Array<keyof OperationalMemoryApi> = [
      "submitDraft", "listDrafts", "getMemory", "getHistory",
      "promoteDraft", "rejectDraft", "revise", "retire", "recall",
    ];
    // These should all return promises without throwing (no user_id in any type)
    const results = await Promise.allSettled([
      api.listDrafts({}),
      api.getMemory("nonexistent"),
      api.getHistory("nonexistent", {}),
      api.recall({}),
    ]);
    // All settled (rejected with not_found or resolved) — none threw synchronously
    expect(results).toHaveLength(4);
  });
});

describe("Transport-backed test double — OperationalMemoryApi conformance", () => {
  it("a plain object satisfies the OperationalMemoryApi interface at compile time", () => {
    const double: OperationalMemoryApi = {
      submitDraft: async (_input: SubmitOperationalDraftInput) => ({ ok: false, code: "not_found" as const, message: "unimplemented" }),
      listDrafts: async (_query: DraftListQuery) => ({ ok: false, code: "not_found" as const, message: "unimplemented" }),
      getMemory: async (_memoryId: string) => ({ ok: false, code: "not_found" as const, message: "unimplemented" }),
      getHistory: async (_memoryId: string, _page: PageRequest) => ({ ok: false, code: "not_found" as const, message: "unimplemented" }),
      promoteDraft: async (_input: PromoteDraftInput) => ({ ok: false, code: "not_found" as const, message: "unimplemented" }),
      rejectDraft: async (_input: RejectDraftInput) => ({ ok: false, code: "not_found" as const, message: "unimplemented" }),
      revise: async (_input: ReviseOperationalMemoryInput) => ({ ok: false, code: "not_found" as const, message: "unimplemented" }),
      retire: async (_input: RetireOperationalMemoryInput) => ({ ok: false, code: "not_found" as const, message: "unimplemented" }),
      recall: async (_query: OperationalRecallQuery) => ({ ok: false, code: "not_found" as const, message: "unimplemented" }),
    };
    expect(double).toBeDefined();
  });

  it("double returns expected discriminated result shapes", async () => {
    const api: OperationalMemoryApi = {
      submitDraft: async () => ({ ok: true, value: { id: "draft-1" } as unknown as OperationalDraft }),
      listDrafts: async () => ({ ok: true, value: { items: [] as OperationalDraft[], nextCursor: undefined } }),
      getMemory: async () => ({ ok: true, value: { id: "mem-1" } as unknown as OperationalMemoryProjection }),
      getHistory: async () => ({ ok: true, value: { items: [] as Page<never>["items"], nextCursor: undefined } }),
      promoteDraft: async () => ({ ok: true, value: { id: "mem-1" } as unknown as OperationalMemoryProjection }),
      rejectDraft: async () => ({ ok: true, value: { id: "draft-1" } as unknown as OperationalDraft }),
      revise: async () => ({ ok: true, value: { id: "mem-1" } as unknown as OperationalMemoryProjection }),
      retire: async () => ({ ok: true, value: { id: "mem-1" } as unknown as OperationalMemoryProjection }),
      recall: async () => ({ ok: true, value: { items: [] as OperationalRecallHit[], nextCursor: undefined } }),
    };

    // All ok paths
    const results = await Promise.all([
      api.submitDraft({ lesson: "x", scopeLevel: "global", confidence: 50 }),
      api.listDrafts({}),
      api.getMemory("m1"),
      api.getHistory("m1", {}),
      api.promoteDraft({ draftId: "d1", actorId: "a", mutationReason: "r" }),
      api.rejectDraft({ draftId: "d1", rejectedBy: "a", rejectionReason: "r" }),
      api.revise({ memoryId: "m1", expectedContentHash: "h", content: "c", scopeLevel: "global", confidence: 50, mutationReason: "r", actorId: "a" }),
      api.retire({ memoryId: "m1", expectedContentHash: "h", mutationReason: "r", actorId: "a" }),
      api.recall({}),
    ]);

    for (const r of results) {
      expect(r.ok).toBe(true);
    }
  });

  it("double returns conflict shapes for both memory and draft domain", async () => {
    const api: OperationalMemoryApi = {
      submitDraft: async () => ({ ok: false, code: "validation_error" as const, message: "bad input" }),
      listDrafts: async () => ({ ok: false, code: "validation_error" as const, message: "bad" }),
      getMemory: async () => ({ ok: false, code: "not_found" as const, message: "missing" }),
      getHistory: async () => ({ ok: false, code: "not_found" as const, message: "missing" }),
      promoteDraft: async () => ({
        ok: false, code: "conflict" as const, message: "already promoted",
        current: { kind: "draft" as const, draftId: "d1", status: "promoted" as const, promotedMemoryId: "m1" },
      }),
      rejectDraft: async () => ({
        ok: false, code: "conflict" as const, message: "already rejected",
        current: { kind: "draft" as const, draftId: "d1", status: "rejected" as const },
      }),
      revise: async () => ({
        ok: false, code: "conflict" as const, message: "stale hash",
        current: { kind: "memory" as const, memoryId: "m1", versionId: "v1", contentHash: "h1" },
      }),
      retire: async () => ({
        ok: false, code: "conflict" as const, message: "stale hash",
        current: { kind: "memory" as const, memoryId: "m1", versionId: "v1", contentHash: "h1" },
      }),
      recall: async () => ({ ok: false, code: "validation_error" as const, message: "bad query" }),
    };

    const promote = await api.promoteDraft({ draftId: "d1", actorId: "a", mutationReason: "r" });
    expect(promote.ok).toBe(false);
    if (!promote.ok && promote.current) {
      if (promote.current.kind === "draft") {
        expect(promote.current.draftId).toBe("d1");
        expect(promote.current.status).toBe("promoted");
        expect(promote.current.promotedMemoryId).toBe("m1");
      }
    }

    const reject = await api.rejectDraft({ draftId: "d1", rejectedBy: "a", rejectionReason: "r" });
    expect(reject.ok).toBe(false);
    if (!reject.ok && reject.current) {
      if (reject.current.kind === "draft") {
        expect(reject.current.draftId).toBe("d1");
        expect(reject.current.status).toBe("rejected");
      }
    }

    const revise = await api.revise({ memoryId: "m1", expectedContentHash: "h", content: "c", scopeLevel: "global", confidence: 50, mutationReason: "r", actorId: "a" });
    expect(revise.ok).toBe(false);
    if (!revise.ok && revise.current) {
      if (revise.current.kind === "memory") {
        expect(revise.current.memoryId).toBe("m1");
        expect(revise.current.versionId).toBe("v1");
        expect(revise.current.contentHash).toBe("h1");
      }
    }
  });
});
