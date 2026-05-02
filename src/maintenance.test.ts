import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import type { MessageRecord } from "./mem-types.js";

describe("MemoryManager — maintenance methods", () => {
  let tmpDir: string;
  let mm: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mm-maint-"));
    mm = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await mm.initialize({ skipEmbeddingCheck: true });
  });

  afterEach(() => {
    mm.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("runWalCheckpoint", () => {
    it("returns true on initialized DB", () => {
      expect(mm.runWalCheckpoint()).toBe(true);
    });

    it("returns false when DB is closed", () => {
      mm.close();
      expect(mm.runWalCheckpoint()).toBe(false);
    });
  });

  describe("rebuildFtsIndexes", () => {
    it("returns empty rebuilt array when indexes are healthy", () => {
      const result = mm.rebuildFtsIndexes();
      expect(result.rebuilt).toEqual([]);
    });

    it("returns empty when DB is closed", () => {
      mm.close();
      expect(mm.rebuildFtsIndexes()).toEqual({ rebuilt: [] });
    });
  });

  describe("deduplicateMessages", () => {
    it("removes consecutive duplicate messages", () => {
      const base: MessageRecord = { userId: "user-1", role: "user", content: "hello", timestamp: Date.now(), sessionId: "s1", platformMessageId: 0 };
      mm.recordMessage({ ...base, timestamp: 1000 });
      mm.recordMessage({ ...base, timestamp: 2000 });
      mm.recordMessage({ ...base, timestamp: 3000 });

      const result = mm.deduplicateMessages();
      expect(result.removed).toBeGreaterThanOrEqual(1);
    });

    it("returns 0 when no duplicates", () => {
      const base: MessageRecord = { userId: "user-1", role: "user", content: "", timestamp: Date.now(), sessionId: "s1", platformMessageId: 0 };
      mm.recordMessage({ ...base, content: "hello", timestamp: 1000 });
      mm.recordMessage({ ...base, content: "world", timestamp: 2000 });

      expect(mm.deduplicateMessages()).toEqual({ removed: 0 });
    });

    it("returns 0 when DB is closed", () => {
      mm.close();
      expect(mm.deduplicateMessages()).toEqual({ removed: 0 });
    });
  });

  describe("cleanupOldMessages", () => {
    it("deletes messages older than maxAgeDays", () => {
      const old: MessageRecord = { userId: "user-1", role: "user", content: "old", timestamp: Date.now() - 10 * 86400000, sessionId: "s1", platformMessageId: 0 };
      const recent: MessageRecord = { userId: "user-1", role: "user", content: "new", timestamp: Date.now(), sessionId: "s1", platformMessageId: 0 };
      mm.recordMessage(old);
      mm.recordMessage(recent);

      const result = mm.cleanupOldMessages({ maxCount: 10000, maxAgeDays: 5, garbageHours: 12 });
      expect(result.deleted).toBe(1);
    });

    it("returns 0 when DB is closed", () => {
      mm.close();
      expect(mm.cleanupOldMessages({ maxCount: 100, maxAgeDays: 7, garbageHours: 12 })).toEqual({ deleted: 0 });
    });
  });

  describe("backfillEmbeddings", () => {
    it("returns 0 when no NULL embeddings", async () => {
      const result = await mm.backfillEmbeddings(async () => new Float32Array([1, 2, 3]));
      expect(result.embedded).toBe(0);
    });

    it("returns 0 when DB is closed", async () => {
      mm.close();
      const result = await mm.backfillEmbeddings(async () => new Float32Array([1]));
      expect(result).toEqual({ embedded: 0 });
    });
  });

  describe("fixMemoryDefaults", () => {
    it("returns 0 when nothing to fix", () => {
      expect(mm.fixMemoryDefaults()).toEqual({ fixed: 0 });
    });

    it("returns 0 when DB is closed", () => {
      mm.close();
      expect(mm.fixMemoryDefaults()).toEqual({ fixed: 0 });
    });
  });

  describe("getLastMessageTimestamp", () => {
    it("returns 0 when no messages", () => {
      expect(mm.getLastMessageTimestamp()).toBe(0);
    });

    it("returns latest timestamp after recording", () => {
      const ts = Date.now();
      mm.recordMessage({ userId: "user-1", role: "user", content: "hi", timestamp: ts, sessionId: "s1", platformMessageId: 0 });
      expect(mm.getLastMessageTimestamp()).toBe(ts);
    });
  });
});
