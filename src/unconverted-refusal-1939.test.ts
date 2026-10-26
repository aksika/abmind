/**
 * #1939 2b — unconverted datasets fail closed on every personal route.
 *
 * Protection: after the legacy extracted-memory branches are removed, an
 * unconverted (legacy-state) dataset must refuse store, mutation, recall,
 * hydration and sleep with the existing "conversion required" reason instead
 * of writing rows no supported view can serve. Only status, inspection and
 * conversion remain usable. If the uniform gate is removed or bypassed, at
 * least one assertion below fails.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager, getMemoryDb } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { setPersonalState } from "./personal-schema.js";
import { dispatchAssembleSessionContext } from "./abmind-memory-dispatch.js";
import { setupTestEnv, type TestEnv } from "./sleep/test-harness.js";
import { runSleepCycle } from "./sleep/orchestrator.js";
import type { EffectivePrivateMutationContext } from "./mem-types.js";

const OWNER = "refusal-owner";
const REASON = "conversion required: refusal test dataset";

function mutationContext(userId: string): EffectivePrivateMutationContext {
  return {
    userId,
    actorId: "refusal-test",
    operationKey: `refusal-${Date.now()}`,
    canDeclassifySecret: false,
    origin: "internal",
  };
}

describe("unconverted datasets fail closed (#1939 2b)", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "refusal-2b-"));
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir), { ownerSnapshot: OWNER });
    await manager.initialize({ skipEmbeddingCheck: true });
    setPersonalState(getMemoryDb(manager)!, "legacy", { reason: REASON });
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refuses store, mutation, recall and hydration with conversion required", async () => {
    // Store: the legacy extracted path is deleted; the readiness gate
    // refuses before any write.
    const stored = await manager.editor.instantStore({
      userId: OWNER,
      contentEn: "refused fact",
      contentOriginal: "refused fact",
      memoryType: "fact",
      emotionScore: 0,
    });
    expect(stored.stored).toBe(false);
    if (!stored.stored) {
      expect(stored.code).toBe("unavailable");
      expect(stored.message).toContain("conversion required");
    }
    expect(
      (getMemoryDb(manager)!.prepare("SELECT COUNT(*) AS c FROM long_term_memories").get() as { c: number }).c,
    ).toBe(0);

    // Mutation: the legacy edit transaction is deleted; the uniform gate
    // refuses before any row is read.
    const mutated = manager.editor.getMutationStore().edit(mutationContext(OWNER), {
      userId: OWNER,
      memoryId: 1,
      expectedRevision: 1,
      contentEn: "changed",
    });
    expect(mutated.ok).toBe(false);
    if (!mutated.ok && mutated.code === "validation_error") {
      expect(mutated.message).toContain("conversion required");
    } else {
      throw new Error("expected a validation_error refusal");
    }

    // Recall: the owned pipeline never runs on an unconverted dataset.
    await expect(
      manager.recall({
        contract: "owned-v1",
        profile: "recall_fast",
        identity: { principal: OWNER },
        rawTurn: "refused fact",
      }),
    ).rejects.toThrow(/conversion required/);

    // Hydration: session assembly refuses before composing any context.
    expect(() => manager.getSessionParts()).toThrow(/personal hydration refused/);
    expect(() => dispatchAssembleSessionContext(manager, { userId: OWNER })).toThrow(/personal hydration refused/);
  });

  it("refuses sleep with conversion required", async () => {
    const env: TestEnv = await setupTestEnv({ seedMessages: 0 });
    try {
      setPersonalState(getMemoryDb(env.memory)!, "legacy", { reason: REASON });
      await expect(
        runSleepCycle({
          runtime: env.runtime,
          memoryManager: env.memory,
          now: () => env.now,
          timeoutMs: 55 * 60_000,
          fresh: true,
          betweenStepBackoffMs: () => 0,
          memoryConfigOverride: { memoryDir: env.memoryDir, memoryEnabled: true },
        }),
      ).rejects.toThrow(/conversion required/);
    } finally {
      env.cleanup();
    }
  });
});
