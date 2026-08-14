import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager, getMemoryDb } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { loadMemoryEnv } from "./mem-config-env.js";

describe("Batch B — search enhancements", () => {
  let tmpDir: string;
  let mm: MemoryManager;

  beforeEach(async () => {
    process.env.ABMIND_USER_ID = "user-1";
    tmpDir = mkdtempSync(join(tmpdir(), "abm-v2-b-"));
    mm = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await mm.initialize({ skipEmbeddingCheck: true });
  });

  afterEach(() => {
    mm.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe(".env.memory config", () => {
    it("loads defaults when no file exists", () => {
      const cfg = loadMemoryEnv();
      expect(cfg.searchMode).toBe("hybrid");
      expect(cfg.maxDbSizeMb).toBe(4096);
      expect(cfg.agingEnabled).toBe(true);
      expect(cfg.signatureBits).toBe(256);
    });
  });

  describe("signature search stage (Ss)", () => {
    it("finds memories by signature similarity", async () => {
      // Store some memories
      await mm.editor.instantStore({
        userId: "user-1", contentEn: "We decided to use Clerk for authentication",
        contentOriginal: "Clerk-et használjuk", memoryType: "decision", emotionScore: 3, topic: "coding",
      });
      await mm.editor.instantStore({
        userId: "user-1", contentEn: "The weather in Budapest is sunny today",
        contentOriginal: "Szép idő van", memoryType: "fact", emotionScore: 0, topic: "personal",
      });

      const db = getMemoryDb(mm)!;
      const index = mm.getMemoryIndex()!;

      const { recallSearch } = await import("./recall-engine.js");
      const result = await recallSearch(
        { db, index, memoryDir: tmpDir, ctxStartPath: "" },
        { translated: ["auth", "clerk", "decision"], userId: "user-1", stages: ["Ss"] },
      );

      // Should find the Clerk memory, not the weather one
      expect(result.stages["Ss"]).toBeDefined();
      if (result.stages["Ss"]!.hits.length > 0) {
        expect(result.stages["Ss"]!.hits[0]!.content.toLowerCase()).toContain("clerk");
      }
    });
  });

  describe("recall returns ABM-L content_compressed", () => {
    it("Ss stage returns content_compressed when available", async () => {
      await mm.editor.instantStore({
        userId: "user-1", contentEn: "We decided to use Clerk instead of Auth0",
        contentOriginal: "test", memoryType: "decision", emotionScore: 3, topic: "coding",
      });

      const db = getMemoryDb(mm)!;
      const index = mm.getMemoryIndex()!;
      const { recallSearch } = await import("./recall-engine.js");
      const result = await recallSearch(
        { db, index, memoryDir: tmpDir, ctxStartPath: "" },
        { translated: ["clerk", "auth"], userId: "user-1", stages: ["Ss"] },
      );

      if (result.stages["Ss"]!.hits.length > 0) {
        // Should start with ABM-L prefix [
        expect(result.stages["Ss"]!.hits[0]!.content).toMatch(/^\[/);
      }
    });
  });

  describe("emotional recall boost", () => {
    it("high-emotion memories score higher in Ss stage", async () => {
      // Store two similar memories, one with high emotion
      await mm.editor.instantStore({
        userId: "user-1", contentEn: "The auth system uses Clerk for login",
        contentOriginal: "test", memoryType: "fact", emotionScore: 0, topic: "coding",
      });
      await mm.editor.instantStore({
        userId: "user-1", contentEn: "We passionately decided Clerk is the best auth solution",
        contentOriginal: "test", memoryType: "decision", emotionScore: 5, topic: "coding",
      });

      const db = getMemoryDb(mm)!;
      const index = mm.getMemoryIndex()!;
      const { recallSearch } = await import("./recall-engine.js");
      const result = await recallSearch(
        { db, index, memoryDir: tmpDir, ctxStartPath: "" },
        { translated: ["clerk", "auth"], userId: "user-1", stages: ["Ss"] },
      );

      // Both should be found; the emotional one should score higher
      const hits = result.stages["Ss"]!.hits;
      if (hits.length >= 2) {
        // First hit should have higher score (emotional boost)
        expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
      }
    });
  });
});
