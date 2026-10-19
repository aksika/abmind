import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager, getMemoryDb } from "../memory-manager.js";
import { makeMemoryTestConfig } from "../test-helpers.js";
import { HostMemoryLifecycle } from "./lifecycle.js";
import type { ExecutionIdentity } from "./types.js";
import { buildRecallProjection } from "../recall-projection-build.js";

async function buildFor(manager: MemoryManager, owner: string): Promise<void> {
  // #1928 M3: maintained routes serve the owned indexed pipeline, so recall
  // fixtures must be built into the serving generation.
  const db = getMemoryDb(manager);
  if (!db) throw new Error("expected memory db");
  expect(buildRecallProjection(db, owner, { verifiedBackup: true }).ok).toBe(true);
}

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

  describe("prepareTurn — common fast core", () => {
    it("returns an unavailable packet when no memories exist", async () => {
      const result = await lifecycle.prepareTurn({
        identity: makeIdentity(),
        prompt: "hello",
      });
      expect(result.packet.contract).toBe("owned-v1");
      expect(result.packet.profile).toBe("recall_fast");
      expect(result.diagnostics).toHaveLength(0);
    });

    it("returns owner items and text for matching memories", async () => {
      await mm.editor.instantStore({
        userId: principalA,
        contentEn: "User likes TypeScript strict mode",
        contentOriginal: "User likes TypeScript strict mode",
        memoryType: "fact",
        emotionScore: 0,
        topic: "coding",
      });
      await buildFor(mm, principalA);

      // Provider-off composition: deterministic evidence, no Se degradation.
      const provider = vi.spyOn(mm, "getEmbeddingProvider").mockReturnValue(null);
      let result;
      try {
        result = await lifecycle.prepareTurn({
          identity: makeIdentity(),
          prompt: "Tell me about TypeScript",
        });
      } finally {
        provider.mockRestore();
      }

      expect(result.packet.items.length).toBeGreaterThanOrEqual(1);
      expect(result.packet.text).toContain("TypeScript");
      expect(result.packet.status).toBe("evidence");
    });

    it("plans the verbatim turn with no host translation", async () => {
      const spy = vi.spyOn(mm, "recall");
      await lifecycle.prepareTurn({
        identity: makeIdentity(),
        prompt: "köszi szépen",
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const request = spy.mock.calls[0]![0];
      expect(request.profile).toBe("recall_fast");
      expect(request.rawTurn).toBe("köszi szépen");
      expect(request).not.toHaveProperty("translated");
      spy.mockRestore();
    });

    it("verified context snapshots ride as owned context", async () => {
      await mm.editor.instantStore({
        userId: principalA,
        contentEn: "The deployment pipeline runs nightly",
        contentOriginal: "The deployment pipeline runs nightly",
        memoryType: "fact",
        emotionScore: 0,
      });
      await buildFor(mm, principalA);

      const result = await lifecycle.prepareTurn({
        identity: makeIdentity(),
        prompt: "how do we deploy",
        context: [{
          text: "the deployment pipeline steps",
          principal: principalA,
          host: "test",
          conversation: convA,
          executionId: "exec-0",
          complete: true,
          recencyRank: 0,
        }],
      });

      expect(result.packet.items.length).toBeGreaterThanOrEqual(1);
    });

    it("honors host capacity without host floors", async () => {
      const spy = vi.spyOn(mm, "recall");
      await lifecycle.prepareTurn({
        identity: makeIdentity(),
        prompt: "test",
        capacity: { maxItems: 3, maxOutputBytes: 500 },
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const request = spy.mock.calls[0]![0];
      expect(request.capacity).toEqual({ maxItems: 3, maxOutputBytes: 500 });
      expect(request).not.toHaveProperty("minScore");
      spy.mockRestore();
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
      await buildFor(mm, principalA);

      const resultA = await lifecycle.prepareTurn({
        identity: makeIdentity(),
        prompt: "hiking",
      });

      const lifecycleB = new HostMemoryLifecycle(mm, { writerId: ownerId });
      const resultB = await lifecycleB.prepareTurn({
        identity: makeIdentity({ principalId: principalB, conversationId: convB }),
        prompt: "cooking",
      });

      const itemsA = resultA.packet.items.filter((i) => i.excerpt.includes("Alice"));
      expect(itemsA.length).toBeGreaterThanOrEqual(1);
      expect(resultA.packet.items.some((i) => i.excerpt.includes("Bob"))).toBe(false);
      // #1928 R5: the foreign legacy row is unconverted, and legacy stores
      // refuse personal serving on every route — no retargeting, no fallback.
      // Conversion (not recall) owns making foreign history servable.
      const itemsB = resultB.packet.items.filter((i) => i.excerpt.includes("Bob"));
      expect(itemsB).toHaveLength(0);
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
      });
      expect(result.packet.status).toBe("unavailable");
      expect(result.packet.items).toHaveLength(0);
      expect(result.diagnostics).toHaveLength(0);
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
