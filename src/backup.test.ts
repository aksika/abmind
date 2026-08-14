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
    db.prepare("INSERT INTO entity_graph (entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at) VALUES ('alice', 'bob', 'friend_of', 1, 1000, 1000)").run();

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
