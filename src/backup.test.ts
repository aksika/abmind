import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeDatabase } from "../src/memory-db.js";
import { createBackup, restoreBackup } from "../src/backup.js";
import { OperationalMemoryStore } from "../src/operational-memory-store.js";
import type Database from "better-sqlite3";

describe("backup/restore", () => {
  let tmpDir: string;
  let db: Database.Database;
  let memoryDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "abmind-backup-test-"));
    memoryDir = join(tmpDir, "memory");
    mkdirSync(memoryDir, { recursive: true });
    db = initializeDatabase(join(memoryDir, "memory.db"));

    // Seed data
    db.prepare(`INSERT INTO extracted_memories (user_id, content_original, content_en, memory_type, source_timestamp, created_at, emotion_score)
      VALUES ('user1', 'eredeti', 'english content', 'fact', 1000, 1000, 0)`).run();
    db.prepare(`INSERT INTO extracted_memories (user_id, content_original, content_en, memory_type, source_timestamp, created_at, emotion_score)
      VALUES ('user1', 'masodik', 'second memory', 'decision', 2000, 2000, 2)`).run();
    db.prepare("INSERT INTO entity_graph (user_id, entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at) VALUES ('user1', 'alice', 'bob', 'friend_of', 1, 1000, 1000)").run();

    // Seed .md file
    mkdirSync(join(memoryDir, "daily"), { recursive: true });
    writeFileSync(join(memoryDir, "daily", "daily_20260428.md"), "# Daily\nSome content");
  });

  afterEach(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

  it("backup creates encrypted file", () => {
    const outPath = join(tmpDir, "test.abm");
    const result = createBackup(db, memoryDir, "testpass123", outPath);
    expect(result.memories).toBe(2);
    expect(result.files).toBe(1);
    expect(existsSync(outPath)).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(100);
  });

  it("restore --replace recovers all data", () => {
    const outPath = join(tmpDir, "test.abm");
    createBackup(db, memoryDir, "testpass123", outPath);

    // Wipe
    db.exec("DELETE FROM extracted_memories");
    db.exec("DELETE FROM entity_graph");
    expect((db.prepare("SELECT COUNT(*) as c FROM extracted_memories").get() as any).c).toBe(0);

    // Restore
    const result = restoreBackup(db, memoryDir, "testpass123", outPath, "replace");
    expect(result.restored).toBe(2);
    expect((db.prepare("SELECT COUNT(*) as c FROM extracted_memories").get() as any).c).toBe(2);
    expect((db.prepare("SELECT COUNT(*) as c FROM entity_graph").get() as any).c).toBe(1);
  });

  it("restore --merge skips duplicates", () => {
    const outPath = join(tmpDir, "test.abm");
    createBackup(db, memoryDir, "testpass123", outPath);

    // Restore on top of existing data
    const result = restoreBackup(db, memoryDir, "testpass123", outPath, "merge");
    expect(result.skipped).toBe(2); // both already exist (same IDs)
    expect(result.restored).toBe(0);
  });

  it("wrong passphrase throws", () => {
    const outPath = join(tmpDir, "test.abm");
    createBackup(db, memoryDir, "correct", outPath);
    expect(() => restoreBackup(db, memoryDir, "wrong", outPath, "merge")).toThrow("Decryption failed");
  });

  it("restores .md files", () => {
    const outPath = join(tmpDir, "test.abm");
    createBackup(db, memoryDir, "pass", outPath);

    // Delete the file
    rmSync(join(memoryDir, "daily", "daily_20260428.md"));
    expect(existsSync(join(memoryDir, "daily", "daily_20260428.md"))).toBe(false);

    restoreBackup(db, memoryDir, "pass", outPath, "replace");
    expect(existsSync(join(memoryDir, "daily", "daily_20260428.md"))).toBe(true);
  });

  it("preserves restored owners exactly and flags legacy databases needing attribution repair", () => {
    // Write a manifest with a canonical primary identity, then back up a
    // database that contains a foreign owner.
    const manifestPath = join(tmpDir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ encryptionUser: "primary-user" }));
    const outPath = join(tmpDir, "test.abm");
    createBackup(db, memoryDir, "testpass123", outPath);

    const targetDir = join(tmpDir, "target-memory");
    mkdirSync(targetDir, { recursive: true });
    const target = initializeDatabase(join(targetDir, "memory.db"));
    try {
      const result = restoreBackup(target, targetDir, "testpass123", outPath, "replace");
      expect(result.restoredOwners).toEqual(["user1"]);
      expect(result.attributionRepairRequired).toBe(true);
    } finally {
      target.close();
    }
  });

  it("round-trips owner-scoped entity graph rows and skips unattributable legacy edges", () => {
    db.prepare("INSERT INTO entity_graph (user_id, entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at) VALUES ('user1', 'carol', 'dave', 'friend_of', 2, 1000, 1000)").run();
    const outPath = join(tmpDir, "test.abm");
    createBackup(db, memoryDir, "testpass123", outPath);

    const targetDir = join(tmpDir, "target-memory");
    mkdirSync(targetDir, { recursive: true });
    const target = initializeDatabase(join(targetDir, "memory.db"));
    try {
      const result = restoreBackup(target, targetDir, "testpass123", outPath, "replace");
      expect(result.restored).toBe(2);
      const rows = target.prepare("SELECT user_id, entity_a, entity_b FROM entity_graph ORDER BY id").all() as Array<{ user_id: string; entity_a: string }>;
      expect(rows).toEqual([
        { user_id: "user1", entity_a: "alice", entity_b: "bob" },
        { user_id: "user1", entity_a: "carol", entity_b: "dave" },
      ]);
    } finally {
      target.close();
    }
  });

  it("legacy restore derives graph owners from restored sources and discards unattributable edges", () => {
    // Build a backup from a legacy-shape entity_graph (no user_id column):
    // initializeDatabase creates the new schema, then we drop and recreate the
    // table in legacy shape so createBackup serializes rows without user_id.
    const legacyDir = join(tmpDir, "legacy-src");
    mkdirSync(legacyDir, { recursive: true });
    const legacyDb = initializeDatabase(join(legacyDir, "memory.db"));
    try {
      legacyDb.prepare(`INSERT INTO extracted_memories (user_id, content_original, content_en, memory_type, source_timestamp, created_at, emotion_score)
        VALUES ('user1', 'x', 'legacy source', 'fact', 1000, 1000, 0)`).run();
      legacyDb.exec("DROP TABLE entity_graph");
      legacyDb.exec(`CREATE TABLE entity_graph (
        id INTEGER PRIMARY KEY,
        entity_a TEXT NOT NULL, entity_b TEXT NOT NULL, relation TEXT NOT NULL,
        source_memory_id INTEGER, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
      )`);
      legacyDb.exec(`INSERT INTO entity_graph (entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at) VALUES ('a', 'b', 'r', 1, 1, 1)`);
      legacyDb.exec(`INSERT INTO entity_graph (entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at) VALUES ('c', 'd', 'r', NULL, 1, 1)`);

      const legacyPath = join(tmpDir, "legacy.abm");
      createBackup(legacyDb, legacyDir, "testpass123", legacyPath);

      const targetDir = join(tmpDir, "legacy-target");
      mkdirSync(targetDir, { recursive: true });
      const target = initializeDatabase(join(targetDir, "memory.db"));
      try {
        const result = restoreBackup(target, targetDir, "testpass123", legacyPath, "replace");
        expect(result.restored).toBe(1);
        const rows = target.prepare("SELECT user_id, entity_a, entity_b FROM entity_graph").all() as Array<{ user_id: string; entity_a: string; entity_b: string }>;
        // Source-backed legacy edge derived its owner from the restored source;
        // the source-less edge was discarded as unattributable.
        expect(rows).toEqual([{ user_id: "user1", entity_a: "a", entity_b: "b" }]);
      } finally {
        target.close();
      }
    } finally {
      legacyDb.close();
    }
  });

  it("rolls back memory replacement when graph restore fails", () => {
    const badDir = join(tmpDir, "bad-source");
    mkdirSync(badDir, { recursive: true });
    const badDb = initializeDatabase(join(badDir, "memory.db"));
    const badPath = join(tmpDir, "bad-graph.abm");
    try {
      badDb.prepare(`INSERT INTO extracted_memories
        (user_id, content_original, content_en, memory_type, source_timestamp, created_at, emotion_score)
        VALUES ('bad-owner', 'bad', 'bad source', 'fact', 1000, 1000, 0)`).run();
      // A legacy-shaped graph table can contain malformed rows that the new
      // owner-scoped table correctly rejects. The memory and graph restore
      // must still be atomic together.
      badDb.exec("DROP TABLE entity_graph");
      badDb.exec(`CREATE TABLE entity_graph (
        id INTEGER PRIMARY KEY,
        entity_a TEXT,
        entity_b TEXT NOT NULL,
        relation TEXT NOT NULL,
        source_memory_id INTEGER,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      )`);
      badDb.prepare(
        "INSERT INTO entity_graph (entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at) VALUES (NULL, 'b', 'broken', 1, 1, 1)",
      ).run();
      createBackup(badDb, badDir, "testpass123", badPath);
    } finally {
      badDb.close();
    }

    expect(() => restoreBackup(db, memoryDir, "testpass123", badPath, "replace")).toThrow();
    expect((db.prepare("SELECT COUNT(*) AS c FROM extracted_memories").get() as { c: number }).c).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS c FROM entity_graph").get() as { c: number }).c).toBe(1);
  });

  it("does not require attribution repair when every restored row is the primary owner", () => {
    const manifestPath = join(tmpDir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ encryptionUser: "user1" }));
    const outPath = join(tmpDir, "test.abm");
    createBackup(db, memoryDir, "testpass123", outPath);

    const targetDir = join(tmpDir, "target-memory");
    mkdirSync(targetDir, { recursive: true });
    const target = initializeDatabase(join(targetDir, "memory.db"));
    try {
      const result = restoreBackup(target, targetDir, "testpass123", outPath, "replace");
      expect(result.restoredOwners).toEqual(["user1"]);
      expect(result.attributionRepairRequired).toBe(false);
    } finally {
      target.close();
    }
  });

  it("restores a promoted operational-memory aggregate", () => {
    const store = new OperationalMemoryStore(db);
    const draft = store.createDraft({ lesson: "Use the focused suite", suggestedScopeLevel: "global", confidence: 90 });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const promoted = store.promoteDraft({ draftId: draft.value.id, actorId: "reviewer", mutationReason: "approved" });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;

    const outPath = join(tmpDir, "operational.abm");
    createBackup(db, memoryDir, "testpass123", outPath);
    const targetDir = join(tmpDir, "target-memory");
    mkdirSync(targetDir, { recursive: true });
    const target = initializeDatabase(join(targetDir, "memory.db"));
    try {
      restoreBackup(target, targetDir, "testpass123", outPath, "replace");
      expect((target.prepare("SELECT COUNT(*) as c FROM operational_lesson_drafts").get() as any).c).toBe(1);
      expect((target.prepare("SELECT COUNT(*) as c FROM operational_memories").get() as any).c).toBe(1);
      expect((target.prepare("SELECT COUNT(*) as c FROM operational_memory_versions").get() as any).c).toBe(1);
    } finally {
      target.close();
    }
  });

  it("rejects an operational backup with a mismatched content hash", () => {
    const store = new OperationalMemoryStore(db);
    const draft = store.createDraft({ lesson: "Hash-protected lesson", suggestedScopeLevel: "global", confidence: 90 });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const promoted = store.promoteDraft({ draftId: draft.value.id, actorId: "reviewer", mutationReason: "approved" });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;
    db.exec("DELETE FROM operational_lesson_drafts");
    db.prepare("UPDATE operational_memories SET content_hash = ? WHERE id = ?").run("corrupted", promoted.value.id);

    const outPath = join(tmpDir, "corrupt-operational.abm");
    createBackup(db, memoryDir, "testpass123", outPath);
    expect(() => restoreBackup(db, memoryDir, "testpass123", outPath, "replace")).toThrow("Invalid operational backup");
  });
});
