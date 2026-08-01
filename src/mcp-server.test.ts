import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemoryConfig } from "./memory-config.js";
import { MemoryManager, getMemoryDb } from "./memory-manager.js";
import { createEmbeddedMemoryBackend } from "./backend-factory.js";
import { makeMemoryTestConfig } from "./test-helpers.js";

/**
 * MCP server integration tests — verify tool logic without stdio transport.
 * We import the tool handlers indirectly by calling the same backend/memory methods.
 */
describe("MCP server tool logic", () => {
  let tmpDir: string;
  let memory: MemoryManager;
  let backend: Awaited<ReturnType<typeof createEmbeddedMemoryBackend>>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-test-"));
    process.env["MEMORY_IPC"] = "0";
    const config = makeMemoryTestConfig(tmpDir);
    memory = new MemoryManager(config);
    await memory.initialize({ skipEmbeddingCheck: true });
    backend = await createEmbeddedMemoryBackend(config);
  });

  afterEach(() => {
    memory.close();
    delete process.env["MEMORY_IPC"];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("memory_recall", () => {
    it("returns results for matching query", async () => {
      await backend.instantStore({
        userId: "aksika",
        contentEn: "TypeScript strict mode is essential",
        contentOriginal: "TypeScript strict mode is essential",
        memoryType: "fact",
        emotionScore: 0,
      });
      const result = await backend.recall({ translated: ["TypeScript"], userId: "aksika", limit: 10 });
      expect(result.results.length).toBeGreaterThanOrEqual(1);
      expect(result.results[0]!.content).toContain("TypeScript");
    });

    it("returns empty for non-matching query", async () => {
      const result = await backend.recall({ translated: ["xyznonexistent"], userId: "aksika", limit: 10 });
      expect(result.results).toHaveLength(0);
    });
  });

  describe("memory_store", () => {
    it("stores a memory and returns result", async () => {
      const result = await backend.instantStore({
        userId: "aksika",
        contentEn: "User prefers dark mode",
        contentOriginal: "User prefers dark mode",
        memoryType: "preference",
        emotionScore: 0,
      });
      expect(result.stored).toBe(true);
      expect(result.memoriesCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe("memory_edit", () => {
    it("adjustRelevance changes importance", async () => {
      await backend.instantStore({
        userId: "aksika",
        contentEn: "Important fact to boost",
        contentOriginal: "Important fact to boost",
        memoryType: "fact",
        emotionScore: 0,
      });
      // Get the memory ID
      const db = getMemoryDb(memory)!;
      const row = db.prepare("SELECT id, relevance_score, semantic_revision FROM extracted_memories ORDER BY id DESC LIMIT 1").get() as { id: number; relevance_score: number; semantic_revision: number };
      const before = row.relevance_score;
      await backend.adjustRelevance({ userId: "aksika", memoryId: row.id, expectedRevision: row.semantic_revision, delta: 1 });
      const after = (db.prepare("SELECT relevance_score FROM extracted_memories WHERE id = ?").get(row.id) as { relevance_score: number }).relevance_score;
      expect(after).toBe(before + 1);
    });
  });

  describe("memory_status", () => {
    it("returns stats object", () => {
      const stats = memory.getStats();
      expect(stats).not.toBeNull();
      expect(stats).toHaveProperty("totalMessages");
      expect(stats).toHaveProperty("extractedMemories");
    });
  });

  describe("memory_wakeup", () => {
    it("returns string (may be empty for fresh DB)", () => {
      const wakeup = memory.buildWakeUp();
      expect(typeof wakeup).toBe("string");
    });

    it("respects maxChars", async () => {
      // Store an emotional memory so a flashback is eligible
      await backend.instantStore({
        userId: "aksika",
        contentEn: "Amazing breakthrough on the project, this is a very exciting development",
        contentOriginal: "Amazing breakthrough on the project",
        memoryType: "event",
        emotionScore: 4,
      });

      const small = memory.buildWakeUp(100);
      expect(small.length).toBeLessThanOrEqual(100);

      const large = memory.buildWakeUp(10000);
      expect(large.length).toBeLessThanOrEqual(10000);
      expect(large).toContain("[Flashback]");
    });
  });
});
