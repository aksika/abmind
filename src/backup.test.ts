import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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

    // Seed data (#1939 stage 3: durables, not legacy extracted_memories)
    db.prepare(`INSERT INTO long_term_memories (user_id, memory_type, content, created_at, updated_at)
      VALUES ('user1', 'fact', 'english content', 1000, 1000)`).run();
    db.prepare(`INSERT INTO long_term_memories (user_id, memory_type, content, created_at, updated_at)
      VALUES ('user1', 'decision', 'second memory', 2000, 2000)`).run();

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
    db.exec("DELETE FROM long_term_memories");
    expect((db.prepare("SELECT COUNT(*) as c FROM long_term_memories").get() as any).c).toBe(0);

    // Restore
    const result = restoreBackup(db, memoryDir, "testpass123", outPath, "replace");
    expect(result.restored).toBe(2);
    expect((db.prepare("SELECT COUNT(*) as c FROM long_term_memories").get() as any).c).toBe(2);
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

  it("preserves restored owners exactly", () => {
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
      expect((target.prepare("SELECT COUNT(*) as c FROM long_term_memories").get() as { c: number }).c).toBe(2);
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

  it("exposes the backup-embedded encryption user for manifest repair", () => {
    const outPath = join(tmpDir, "test.abm");
    createBackup(db, memoryDir, "testpass123", outPath);

    // The .abm v2 header embeds the source salt as `abmind:<user>` plaintext.
    const raw = readFileSync(outPath);
    const metaLen = raw.readUInt16LE(10);
    const meta = JSON.parse(raw.subarray(12, 12 + metaLen).toString("utf-8")) as { salt: string };
    const expected = meta.salt.slice("abmind:".length);

    const result = restoreBackup(db, memoryDir, "testpass123", outPath, "merge");
    expect(result.encryptionUser).toBe(expected);
  });

  it("round-trips durables and episodes on a ready dataset; projections rebuild after restore", async () => {
    // #1939 stage-3 acceptance: backup -> replace-restore reproduces durables,
    // episodes and forget state; derived projections are invalidated by the
    // restore and come back through the reviewed rebuild.
    const { ensureInitialized } = await import("./ensure-initialized.js");
    const { setPersonalState } = await import("./personal-schema.js");
    const { storeDurable } = await import("./personal-durable.js");
    const { createEpisode } = await import("./personal-episodes.js");
    const { buildRecallProjection, verifyRecallProjection } = await import("./recall-projection-build.js");
    ensureInitialized(db, memoryDir);
    setPersonalState(db, "ready", { reason: "round-trip test" });

    const msgId = Number(db.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES ('user1', 's1', 'user', 'I prefer tea', 1000)",
    ).run().lastInsertRowid);
    const stored = storeDurable(db, { userId: "user1", memoryType: "fact", content: "prefers tea",
      authority: "user_statement", authorityBasis: "verbatim quote",
      evidence: [{ kind: "user_message", ref: String(msgId), excerpt: "I prefer tea", classification: 1 }],
      actorId: "round-trip" });
    expect(stored.revision).toBe(1);
    const episode = createEpisode(db, { userId: "user1", topic: "drinks", startTs: 1000, endTs: 1000,
      sessionIds: ["s1"], sourceMessageIds: [msgId],
      evidenceExcerpts: [{ messageId: msgId, excerpt: "I prefer tea", classification: 1 }],
      actorId: "round-trip" });
    expect(episode.replayed).toBe(false);

    const outPath = join(tmpDir, "roundtrip.abm");
    createBackup(db, memoryDir, "testpass123", outPath);

    db.exec("DELETE FROM personal_grouping_ledger");
    db.exec("DELETE FROM long_term_revisions");
    db.exec("DELETE FROM long_term_memories");
    db.exec("DELETE FROM short_term_memories");
    db.exec("DELETE FROM messages");
    const result = restoreBackup(db, memoryDir, "testpass123", outPath, "replace");
    // 2 file-level seeds + the durable stored above.
    expect((db.prepare("SELECT COUNT(*) as c FROM long_term_memories").get() as { c: number }).c).toBe(3);
    expect((db.prepare("SELECT COUNT(*) as c FROM short_term_memories").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c).toBe(1);
    expect(result.restoredOwners).toEqual(["user1"]);

    const built = buildRecallProjection(db, "user1", { verifiedBackup: true });
    expect(built.ok).toBe(true);
    expect(verifyRecallProjection(db, "user1", built.generation!).ok).toBe(true);
  });

  it("counts actually inserted messages instead of the backup length", () => {
    for (let i = 0; i < 3; i++) {
      db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES ('user1', 's1', 'user', ?, ?)")
        .run(`hello ${i}`, 1000 + i);
    }
    const outPath = join(tmpDir, "test.abm");
    createBackup(db, memoryDir, "testpass123", outPath);

    // Merge on top of identical data: every row is skipped, none restored.
    const merged = restoreBackup(db, memoryDir, "testpass123", outPath, "merge");
    expect(merged.restored).toBe(0);
    expect(merged.skipped).toBe(5); // 2 memories + 3 messages

    // Replace after wipe: every row is restored.
    db.exec("DELETE FROM long_term_memories");
    db.exec("DELETE FROM messages");
    const replaced = restoreBackup(db, memoryDir, "testpass123", outPath, "replace");
    expect(replaced.restored).toBe(5);
    expect((db.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c).toBe(3);
  });
});
