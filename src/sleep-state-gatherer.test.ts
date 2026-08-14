import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SleepStateGatherer } from "./sleep-state-gatherer.js";
import { initializeDatabase } from "./memory-db.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import type Database from "better-sqlite3";

describe("SleepStateGatherer", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sleep-gather-"));
    mkdirSync(join(tmpDir, "sleep"), { recursive: true });
    mkdirSync(join(tmpDir, "topics"), { recursive: true });
    db = initializeDatabase(join(tmpDir, "memory.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeGatherer(): SleepStateGatherer {
    const mockMemory = { getSleepData: () => ({ getDb: () => db }) } as any;
    return new SleepStateGatherer(mockMemory, makeMemoryTestConfig(tmpDir));
  }

  function insertMemory(contentEn: string, withEmbedding: boolean): void {
    db.prepare(
      "INSERT INTO extracted_memories (user_id, content_original, content_en, memory_type, source_timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(1, contentEn, contentEn, "fact", Date.now(), Date.now());
    if (withEmbedding) {
      const vec = Buffer.from(new Float32Array(768).buffer);
      db.prepare("UPDATE extracted_memories SET embedding = ? WHERE content_en = ?").run(vec, contentEn);
    }
  }

  // ── DbStats ─────────────────────────────────────────────────────────

  describe("queryDbStats via gather()", () => {
    it("counts extracted memories", async () => {
      insertMemory("test1", false);
      insertMemory("test2", false);
      const snapshot = await makeGatherer().gather();
      expect(snapshot.dbStats.extractedMemoryCount).toBe(2);
    });

    it("counts embeddings from extracted_memories.embedding column", async () => {
      insertMemory("with-embed", true);
      insertMemory("no-embed", false);
      const snapshot = await makeGatherer().gather();
      expect(snapshot.dbStats.embeddingCount).toBe(1);
    });

    it("counts NULL embeddings", async () => {
      insertMemory("with-embed", true);
      insertMemory("no-embed-1", false);
      insertMemory("no-embed-2", false);
      const snapshot = await makeGatherer().gather();
      expect(snapshot.dbStats.nullEmbeddingCount).toBe(2);
    });

    it("returns 0 embeddings when none exist", async () => {
      insertMemory("no-embed", false);
      const snapshot = await makeGatherer().gather();
      expect(snapshot.dbStats.embeddingCount).toBe(0);
      expect(snapshot.dbStats.nullEmbeddingCount).toBe(1);
    });

    it("returns 0 nullEmbeddings when all are embedded", async () => {
      insertMemory("embedded", true);
      const snapshot = await makeGatherer().gather();
      expect(snapshot.dbStats.embeddingCount).toBe(1);
      expect(snapshot.dbStats.nullEmbeddingCount).toBe(0);
    });

    it("counts messages", async () => {
      db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)").run("aksika", "s1", "user", "hello", Date.now());
      const snapshot = await makeGatherer().gather();
      expect(snapshot.dbStats.messageCount).toBe(1);
    });

    it("scopes message count and compression ratio to the requested owner", async () => {
      const now = Date.now();
      db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)").run("aksika", "s1", "user", "owner message", now);
      db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)").run("adrika", "s2", "user", "foreign message", now);
      db.prepare(
        `INSERT INTO extracted_memories
           (user_id, content_original, content_en, memory_type, source_timestamp, created_at)
         VALUES (?, ?, ?, 'fact', ?, ?)`,
      ).run("aksika", "owner memory", "owner memory", now, now);
      db.prepare(
        `INSERT INTO extracted_memories
           (user_id, content_original, content_en, memory_type, source_timestamp, created_at)
         VALUES (?, ?, ?, 'fact', ?, ?)`,
      ).run("adrika", "foreign memory", "foreign memory", now, now);

      const snapshot = await makeGatherer().gather("aksika");
      expect(snapshot.dbStats.messageCount).toBe(1);
      expect(snapshot.dbStats.extractedMemoryCount).toBe(1);
      expect(snapshot.dbStats.compressionRatio).toBe(1);
    });
  });

  // ── FTS5 Health ───────────────────────────────────────────────────────

  describe("fts5Health", () => {
    it("reports ok for healthy indexes", async () => {
      const snapshot = await makeGatherer().gather();
      expect(snapshot.fts5Health.messages_fts).toBe("dropped");
      expect(snapshot.fts5Health.extracted_memories_fts).toBe("ok");
      expect(snapshot.fts5Health.extracted_memories_original_fts).toBe("dropped");
    });
  });

  // ── Snapshot completeness ─────────────────────────────────────────────

  describe("snapshot structure", () => {
    it("returns all required fields", async () => {
      const snapshot = await makeGatherer().gather();
      expect(snapshot.timestamp).toBeDefined();
      expect(snapshot.dbStats).toBeDefined();
      expect(snapshot.fts5Health).toBeDefined();
      expect(typeof snapshot.diskUsageBytes).toBe("number");
      expect(typeof snapshot.diskBudgetBytes).toBe("number");
      expect(Array.isArray(snapshot.workingDirs)).toBe(true);
      expect(Array.isArray(snapshot.topicFiles)).toBe(true);
    });
  });
});
