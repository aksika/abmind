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

  function insertDurable(owner: string, content: string): void {
    const now = Date.now();
    db.prepare(
      `INSERT INTO long_term_memories
        (user_id, memory_type, content, authority, applicability_scope, provenance, evidence,
         classification, encrypted, sealed_format_version, revision, semantic_revision, created_at, updated_at)
       VALUES (?, 'fact', ?, 'inference', '{"scope":"general"}', '{}', '[]', 1, 0, 0, 1, 1, ?, ?)`,
    ).run(owner, content, now, now);
  }

  // ── DbStats ─────────────────────────────────────────────────────────

  describe("queryDbStats via gather()", () => {
    it("counts eligible durables", async () => {
      insertDurable("aksika", "durable one");
      insertDurable("aksika", "durable two");
      const snapshot = await makeGatherer().gather("aksika");
      expect(snapshot.dbStats.durableMemoryCount).toBe(2);
    });

    it("excludes superseded, sealed, and classified durables", async () => {
      const now = Date.now();
      insertDurable("aksika", "current durable");
      db.prepare(
        `INSERT INTO long_term_memories
          (user_id, memory_type, content, authority, applicability_scope, provenance, evidence,
           classification, encrypted, sealed_format_version, superseded_by_id, revision, semantic_revision, created_at, updated_at)
         VALUES ('aksika', 'fact', 'old durable', 'inference', '{"scope":"general"}', '{}', '[]', 1, 0, 0, 999, 1, 1, ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO long_term_memories
          (user_id, memory_type, content, authority, applicability_scope, provenance, evidence,
           classification, encrypted, sealed_format_version, revision, semantic_revision, created_at, updated_at)
         VALUES ('aksika', 'fact', 'secret durable', 'inference', '{"scope":"general"}', '{}', '[]', 3, 0, 0, 1, 1, ?, ?)`,
      ).run(now, now);
      const snapshot = await makeGatherer().gather("aksika");
      expect(snapshot.dbStats.durableMemoryCount).toBe(1);
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
      insertDurable("aksika", "owner durable");
      insertDurable("adrika", "foreign durable");

      const snapshot = await makeGatherer().gather("aksika");
      expect(snapshot.dbStats.messageCount).toBe(1);
      expect(snapshot.dbStats.durableMemoryCount).toBe(1);
      expect(snapshot.dbStats.compressionRatio).toBe(1);
    });
  });

  // ── Recall projection ─────────────────────────────────────────────────

  describe("recallProjection", () => {
    it("reports not_built with no serving generation on a fresh database", async () => {
      const snapshot = await makeGatherer().gather();
      expect(snapshot.recallProjection.state).toBe("not_built");
      expect(snapshot.recallProjection.servingGeneration).toBeNull();
    });
  });

  // ── Snapshot completeness ─────────────────────────────────────────────

  describe("snapshot structure", () => {
    it("returns all required fields", async () => {
      const snapshot = await makeGatherer().gather();
      expect(snapshot.timestamp).toBeDefined();
      expect(snapshot.dbStats).toBeDefined();
      expect(snapshot.recallProjection).toBeDefined();
      expect(typeof snapshot.diskUsageBytes).toBe("number");
      expect(typeof snapshot.diskBudgetBytes).toBe("number");
      expect(Array.isArray(snapshot.workingDirs)).toBe(true);
      expect(Array.isArray(snapshot.topicFiles)).toBe(true);
    });
  });
});
