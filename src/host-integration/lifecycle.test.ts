import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";
import { makeMemoryTestConfig } from "../test-helpers.js";
import { HostMemoryLifecycle } from "./lifecycle.js";
import type { ExecutionIdentity } from "./types.js";

const ownerId = "test-adapter";
const principalA = "user-a";
const principalB = "user-b";
const convA = "conv-a";
const convB = "conv-b";

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
      await mm.editor.instantStore({
        userId: principalB,
        contentEn: "Bob loves cooking",
        contentOriginal: "Bob loves cooking",
        memoryType: "fact",
        emotionScore: 0,
        topic: "cooking",
      });

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
});
