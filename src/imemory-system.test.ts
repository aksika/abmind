import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory-manager.js";
import type { IMemorySystem } from "./imemory-system.js";
import { makeMemoryTestConfig } from "./test-helpers.js";

describe("IMemorySystem — interface conformance", () => {
  let tmpDir: string;
  let mm: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mm-iface-"));
    mm = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await mm.initialize({ skipEmbeddingCheck: true });
  });

  afterEach(() => {
    mm.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("MemoryManager satisfies IMemorySystem at compile time", () => {
    // This test verifies the type contract — if MemoryManager doesn't implement
    // all IMemorySystem methods, TypeScript will fail to compile this assignment.
    const system: IMemorySystem = mm;
    expect(system).toBeDefined();
  });

  const requiredMethods: Array<keyof IMemorySystem> = [
    "initialize", "close",
    "recordMessage", "loadRecentMessages", "getLastMessageTimestamp",
    "search", "substringSearch",
    "updateEmotionByPlatformId",
    "getStats", "readCoreKnowledge", "getSessionBundle", "getConfig",
    "runWalCheckpoint", "rebuildFtsIndexes", "cleanupOldMessages",
    "backfillEmbeddings", "deduplicateMessages", "fixMemoryDefaults",
  ];

  for (const method of requiredMethods) {
    it(`implements ${method}`, () => {
      expect(typeof (mm as unknown as Record<string, unknown>)[method]).toBe("function");
    });
  }
});
