import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager, getMemoryDb } from "../memory-manager.js";
import { makeMemoryTestConfig } from "../test-helpers.js";
import { HostMemoryLifecycle } from "./lifecycle.js";
import type { ExecutionIdentity } from "./types.js";

const ownerId = "test-adapter";
const principalA = "user-a";
const principalB = "user-b";
const convA = "conv-a";
const convB = "conv-b";

// #1658: extracted_memories is a Master-only creation domain. principalA is
// the pinned canonical primary identity; foreign rows must be seeded directly
// (as legacy data would exist) because appendInstant rejects non-Master owners.
process.env.ABMIND_USER_ID = principalA;

function makeIdentity(overrides: Partial<ExecutionIdentity> = {}): ExecutionIdentity {
  return {
    principalId: principalA,
    conversationId: convA,
    executionId: "exec-1",
    host: "test",
    origin: "interactive",
    automaticWriteOwner: ownerId,
    ...overrides,
  };
}

describe("HostMemoryLifecycle", () => {
  let tmpDir: string;
  let mm: MemoryManager;
  let lifecycle: HostMemoryLifecycle;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "host-lifecycle-"));
    mm = new MemoryManager(makeMemoryTestConfig(join(tmpDir, "memory")));
    await mm.initialize({ skipEmbeddingCheck: true });
    lifecycle = new HostMemoryLifecycle(mm, { writerId: ownerId });
  });

  afterEach(() => {
    mm.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("startSession", () => {
    it("returns wake-up context on success", async () => {
      const result = await lifecycle.startSession({
        identity: makeIdentity(),
        maxChars: 500,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.context).toContain("[Current time:");
        expect(result.diagnostics).toHaveLength(0);
      }
    });

    it("returns ok:false for invalid identity", async () => {
      const result = await lifecycle.startSession({
        identity: makeIdentity({ principalId: "" }),
        maxChars: 500,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.context).toBe("");
        expect(result.diagnostics.length).toBeGreaterThan(0);
      }
    });
  });

  describe("prepareTurn — automatic recall", () => {
    it("returns empty context when no memories exist", async () => {
      const result = await lifecycle.prepareTurn({
        identity: makeIdentity(),
        prompt: "hello",
        query: { translated: ["hello"] },
        policy: { limit: 5, maxChars: 2000 },
      });
      expect(result.context).toBe("");
      expect(result.hits).toHaveLength(0);
    });

    it("returns matching memories", async () => {
      await mm.editor.instantStore({
        userId: principalA,
        contentEn: "User likes TypeScript strict mode",
        contentOriginal: "User likes TypeScript strict mode",
        memoryType: "fact",
        emotionScore: 0,
        topic: "coding",
      });

      const result = await lifecycle.prepareTurn({
        identity: makeIdentity(),
        prompt: "Tell me about TypeScript",
        query: { translated: ["TypeScript"] },
        policy: { limit: 5, maxChars: 2000 },
      });

      expect(result.hits.length).toBeGreaterThanOrEqual(1);
      expect(result.context).toContain("TypeScript");
    });

    it("clamps policy to safe ranges", async () => {
      const result = await lifecycle.prepareTurn({
        identity: makeIdentity(),
        prompt: "test",
        query: { translated: ["test"] },
        policy: { limit: 999, maxChars: -1, minScore: -5, maxClassification: 5 as any },
      });
      // Should not throw — clamped to [1,50], [1,inf], [0,1], max 2
      expect(result.diagnostics).toHaveLength(0);
    });

    it("isolates two identities", async () => {
      await mm.editor.instantStore({
        userId: principalA,
        contentEn: "Alice loves hiking",
        contentOriginal: "Alice loves hiking",
        memoryType: "fact",
        emotionScore: 0,
        topic: "hiking",
      });
      // Foreign (legacy) row seeded directly — non-Master creation is rejected
      // by the appendInstant gate, but foreign rows from before the policy
      // still exist and must be isolated from the principal's recall.
      const bDb = getMemoryDb(mm)!;
      bDb.prepare(
        `INSERT INTO extracted_memories (user_id, content_original, content_en, memory_type, source_timestamp, created_at, emotion_score, topic)
         VALUES (?, 'Bob loves cooking', 'Bob loves cooking', 'fact', ?, ?, 0, 'cooking')`,
      ).run(principalB, Date.now(), Date.now());

      const resultA = await lifecycle.prepareTurn({
        identity: makeIdentity(),
        prompt: "hiking",
        query: { translated: ["hiking"] },
        policy: { limit: 5, maxChars: 2000 },
      });

      const lifecycleB = new HostMemoryLifecycle(mm, { writerId: ownerId });
      const resultB = await lifecycleB.prepareTurn({
        identity: makeIdentity({ principalId: principalB, conversationId: convB }),
        prompt: "cooking",
        query: { translated: ["cooking"] },
        policy: { limit: 5, maxChars: 2000 },
      });

      const hitsA = resultA.hits.filter(h => h.content.includes("Alice"));
      const hitsB = resultB.hits.filter(h => h.content.includes("Bob"));
      expect(hitsA.length).toBeGreaterThanOrEqual(1);
      expect(hitsB.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("completeTurn — turn recording", () => {
    it("owner records ordered user/assistant messages", async () => {
      const result = lifecycle.completeTurn({
        identity: makeIdentity(),
        user: { content: "Hello" },
        assistant: { content: "Hi there" },
      });

      expect(result.status).toBe("recorded");
      if (result.status === "recorded") {
        expect(result.messageIds.length).toBe(2);

        const msgs = mm.loadRecentMessages(principalA, convA, 10);
        expect(msgs.length).toBeGreaterThanOrEqual(2);
        expect(msgs[msgs.length - 2]!.role).toBe("user");
        expect(msgs[msgs.length - 2]!.content).toBe("Hello");
        expect(msgs[msgs.length - 1]!.role).toBe("assistant");
        expect(msgs[msgs.length - 1]!.content).toBe("Hi there");
      }
    });

    it("non-owner returns skipped with zero writes", () => {
      const nonOwner = new HostMemoryLifecycle(mm, { writerId: "other-adapter" });
      const result = nonOwner.completeTurn({
        identity: makeIdentity(),
        user: { content: "Hello" },
      });

      expect(result.status).toBe("skipped");
      expect(result).toMatchObject({ status: "skipped", reason: "not_owner" });

      const msgs = mm.loadRecentMessages(principalA, convA, 10);
      expect(msgs).toHaveLength(0);
    });

    it("empty messages return skipped", () => {
      const result = lifecycle.completeTurn({
        identity: makeIdentity(),
      });
      expect(result.status).toBe("skipped");
      expect(result).toMatchObject({ status: "skipped", reason: "empty" });
    });

    it("user-only turn records one message", () => {
      const result = lifecycle.completeTurn({
        identity: makeIdentity(),
        user: { content: "Just user" },
      });
      expect(result.status).toBe("recorded");
      if (result.status === "recorded") {
        expect(result.messageIds).toHaveLength(1);
      }
    });
  });

  describe("explicit store", () => {
    it("succeeds for non-owner with provenance", async () => {
      const nonOwner = new HostMemoryLifecycle(mm, { writerId: "other-adapter" });
      const result = await nonOwner.store({
        identity: makeIdentity(),
        contentEn: "Explicit memory from non-owner",
        contentOriginal: "Explicit memory from non-owner",
        memoryType: "fact",
        emotionScore: 0,
      });

      expect(result.stored).toBe(true);
    });
  });

  describe("fail-open behavior", () => {
    it("returns fail-open result on error with default options", async () => {
      const result = await lifecycle.startSession({
        identity: makeIdentity({ principalId: "" }),
        maxChars: 500,
      });
      expect(result.ok).toBe(false);
    });

    it("failOpen:false identity validation still returns diagnostics", async () => {
      const strict = new HostMemoryLifecycle(mm, { writerId: ownerId, failOpen: false });
      const result = await strict.startSession({
        identity: makeIdentity({ principalId: "" }),
        maxChars: 500,
      });
      // Identity validation happens before the memory operation — returns diagnostics, not throws
      expect(result.ok).toBe(false);
    });
  });

  describe("explicit recall", () => {
    it("returns results from recallSearch", async () => {
      await mm.editor.instantStore({
        userId: principalA,
        contentEn: "Remembered fact for explicit recall",
        contentOriginal: "Remembered fact for explicit recall",
        memoryType: "fact",
        emotionScore: 0,
      });

      const result = await lifecycle.recall({
        identity: makeIdentity(),
        query: { translated: ["remembered"] },
      });

      expect(result.hits.length).toBeGreaterThanOrEqual(1);
      expect(result.context).toContain("Remembered");
    });
  });

  describe("fail-open/closed with genuine errors", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("failOpen:true returns fallback on startSession error", async () => {
      vi.spyOn(mm, "buildWakeUp").mockImplementation(() => { throw new Error("DB exploded"); });
      const result = await lifecycle.startSession({
        identity: makeIdentity(),
        maxChars: 500,
      });
      expect(result.ok).toBe(false);
      expect(result.context).toBe("");
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]!.operation).toBe("startSession");
      expect(result.diagnostics[0]!.code).toBe("Error");
    });

    it("failOpen:true returns fallback on prepareTurn error", async () => {
      mm.close();
      const result = await lifecycle.prepareTurn({
        identity: makeIdentity(),
        prompt: "test",
        query: { translated: ["test"] },
        policy: { limit: 5, maxChars: 2000 },
      });
      expect(result.context).toBe("");
      expect(result.hits).toHaveLength(0);
    });

    it("failOpen:true returns fallback on recall error", async () => {
      mm.close();
      const result = await lifecycle.recall({
        identity: makeIdentity(),
        query: { translated: ["test"] },
      });
      expect(result.context).toBe("");
      expect(result.hits).toHaveLength(0);
    });

    it("failOpen:true returns fallback on store error with error message", async () => {
      vi.spyOn(mm.editor, "instantStore").mockRejectedValue(new Error("storage backend unavailable"));
      const result = await lifecycle.store({
        identity: makeIdentity(),
        contentEn: "test",
        contentOriginal: "test",
        memoryType: "fact",
        emotionScore: 0,
      });
      expect(result.stored).toBe(false);
      if (!result.stored) {
        expect(result.code).toBe("unavailable");
        expect(result.message).toContain("storage backend unavailable");
      }
    });

    it("failOpen:true returns fallback on completeTurn error", () => {
      vi.spyOn(mm, "recordMessage").mockImplementation(() => { throw new Error("DB crashed"); });
      const result = lifecycle.completeTurn({
        identity: makeIdentity(),
        user: { content: "Hello" },
      });
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.diagnostic.operation).toBe("completeTurn");
      }
    });

    it("failOpen:false propagates prepareTurn error", async () => {
      const strict = new HostMemoryLifecycle(mm, { writerId: ownerId, failOpen: false });
      mm.close();
      await expect(strict.prepareTurn({
        identity: makeIdentity(),
        prompt: "test",
        query: { translated: ["test"] },
        policy: { limit: 5, maxChars: 2000 },
      })).rejects.toThrow("Memory not initialized");
    });

    it("failOpen:false propagates recall error", async () => {
      const strict = new HostMemoryLifecycle(mm, { writerId: ownerId, failOpen: false });
      mm.close();
      await expect(strict.recall({
        identity: makeIdentity(),
        query: { translated: ["test"] },
      })).rejects.toThrow("Memory not initialized");
    });

    it("failOpen:false propagates startSession error", async () => {
      vi.spyOn(mm, "buildWakeUp").mockImplementation(() => { throw new Error("startup failure"); });
      const strict = new HostMemoryLifecycle(mm, { writerId: ownerId, failOpen: false });
      await expect(strict.startSession({
        identity: makeIdentity(),
        maxChars: 500,
      })).rejects.toThrow("startup failure");
    });

    it("failOpen:false propagates store error", async () => {
      vi.spyOn(mm.editor, "instantStore").mockRejectedValue(new Error("store backend crashed"));
      const strict = new HostMemoryLifecycle(mm, { writerId: ownerId, failOpen: false });
      await expect(strict.store({
        identity: makeIdentity(),
        contentEn: "test",
        contentOriginal: "test",
        memoryType: "fact",
        emotionScore: 0,
      })).rejects.toThrow("store backend crashed");
    });

    it("failOpen:false propagates completeTurn error", () => {
      vi.spyOn(mm, "recordMessage").mockImplementation(() => { throw new Error("DB crashed"); });
      const strict = new HostMemoryLifecycle(mm, { writerId: ownerId, failOpen: false });
      expect(() => strict.completeTurn({
        identity: makeIdentity(),
        user: { content: "Hello" },
      })).toThrow("DB crashed");
    });
  });

  describe("explicit recall — classification ceiling passthrough", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("passes maxClassification:3 to recallSearch without clamping", async () => {
      const spy = vi.spyOn(mm, "recallSearch");
      spy.mockResolvedValue({ results: [], stages: {}, shortCircuitAfter: null, extractedIds: [] });

      await lifecycle.recall({
        identity: makeIdentity(),
        query: { translated: ["test"] },
        maxClassification: 3,
      });

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ maxClassification: 3 }));
    });

    it("default recall leaves maxClassification undefined (recallSearch uses default 2)", async () => {
      const spy = vi.spyOn(mm, "recallSearch");
      spy.mockResolvedValue({ results: [], stages: {}, shortCircuitAfter: null, extractedIds: [] });

      await lifecycle.recall({
        identity: makeIdentity(),
        query: { translated: ["test"] },
      });

      expect(spy.mock.calls[0]![0]!.maxClassification).toBeUndefined();
    });
  });

  describe("interleaved execution IDs within the same conversation", () => {
    it("two executionIds sharing one conversation do not leak state", () => {
      const result1 = lifecycle.completeTurn({
        identity: makeIdentity({ executionId: "exec-alpha", parentExecutionId: undefined }),
        user: { content: "First user message", timestamp: 1000 },
        assistant: { content: "First assistant reply", timestamp: 1001 },
      });
      expect(result1.status).toBe("recorded");

      const result2 = lifecycle.completeTurn({
        identity: makeIdentity({ executionId: "exec-beta", parentExecutionId: "exec-alpha" }),
        user: { content: "Second user message", timestamp: 1002 },
        assistant: { content: "Second assistant reply", timestamp: 1003 },
      });
      expect(result2.status).toBe("recorded");

      const msgs = mm.loadRecentMessages(principalA, convA, 10);
      expect(msgs).toHaveLength(4);
      expect(msgs[0]!.content).toBe("First user message");
      expect(msgs[0]!.role).toBe("user");
      expect(msgs[1]!.content).toBe("First assistant reply");
      expect(msgs[1]!.role).toBe("assistant");
      expect(msgs[2]!.content).toBe("Second user message");
      expect(msgs[2]!.role).toBe("user");
      expect(msgs[3]!.content).toBe("Second assistant reply");
      expect(msgs[3]!.role).toBe("assistant");
    });
  });

  describe("completeTurn partial failure", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("user message succeeds but assistant message fails — only user ID in result", () => {
      const spy = vi.spyOn(mm, "recordMessage");
      spy.mockImplementationOnce((record) => mm.store!.recordMessage(record));
      spy.mockImplementationOnce(() => null);

      const result = lifecycle.completeTurn({
        identity: makeIdentity(),
        user: { content: "User says hello" },
        assistant: { content: "Assistant replies" },
      });

      expect(result.status).toBe("recorded");
      if (result.status === "recorded") {
        expect(result.messageIds).toHaveLength(1);
      }
    });
  });
});
