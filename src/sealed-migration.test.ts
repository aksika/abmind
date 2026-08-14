import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeDatabase } from "./memory-db.js";
import {
  inspectSealedMigration,
  applySealedMigration,
} from "./sealed-migration.js";
import { decrypt, encrypt, _resetKeyCache } from "./crypto.js";
import { _resetAbmindEnv } from "./env-schema.js";
import type Database from "better-sqlite3";

describe("#1660 reviewed sealed-row migration", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    _resetKeyCache();
    _resetAbmindEnv();
    tmpDir = mkdtempSync(join(tmpdir(), "abmind-sealed-mig-"));
    process.env["ABMIND_KEY_FILE"] = join(tmpDir, "secret", "abmind.key");
    process.env.ABMIND_USER_ID = "test";
    _resetAbmindEnv();
    db = initializeDatabase(join(tmpDir, "memory.db"));
  });

  afterEach(() => {
    db.close();
    _resetKeyCache();
    delete process.env["ABMIND_KEY_FILE"];
    _resetAbmindEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertLegacyRow(overrides: {
    id: number;
    encrypted?: number;
    sealedFormatVersion?: number;
    contentEn?: string;
    contentOriginal?: string;
  }): void {
    db.prepare(
      `INSERT INTO extracted_memories
         (id, user_id, content_original, content_en, memory_type, source_timestamp,
          created_at, classification, encrypted, sealed_format_version, semantic_revision)
       VALUES (?, 'test', ?, ?, 'fact', 1000, 1000, 3, ?, ?, 1)`,
    ).run(
      overrides.id,
      overrides.contentOriginal ?? "plain-secret-value",
      overrides.contentEn ?? "plain-secret-value",
      overrides.encrypted ?? 0,
      overrides.sealedFormatVersion ?? 0,
    );
  }

  it("dry-run lists only legacy (non-v1) class-3 rows with metadata only", () => {
    insertLegacyRow({ id: 1, encrypted: 0 });
    insertLegacyRow({ id: 2, encrypted: 1, contentEn: "cipher", contentOriginal: "cipher" });
    insertLegacyRow({ id: 3, encrypted: 1, sealedFormatVersion: 1, contentEn: "sealed ok", contentOriginal: "cipher" });

    const plan = inspectSealedMigration(db);
    expect(plan.candidates.map((c) => c.memoryId)).toEqual([1, 2]);
    expect(plan.candidates[0]).toMatchObject({ encrypted: 0, sealedFormatVersion: 0 });
    expect(plan.ftsIntegrityOk).toBe(true);
  });

  it("refuses apply without a verified backup", () => {
    insertLegacyRow({ id: 1 });
    const outcome = applySealedMigration(db, [
      { memoryId: 1, expectedRevision: 1, action: "leave_quarantined" },
    ], { verifiedBackup: false });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refused).toContain("backup");
  });

  it("refuses unknown, duplicate, stale and missing decisions with no mutation", () => {
    insertLegacyRow({ id: 1 });
    insertLegacyRow({ id: 2 });

    const unknown = applySealedMigration(db, [
      { memoryId: 99, expectedRevision: 1, action: "leave_quarantined" },
    ], { verifiedBackup: true });
    expect(unknown.ok).toBe(false);

    const duplicate = applySealedMigration(db, [
      { memoryId: 1, expectedRevision: 1, action: "leave_quarantined" },
      { memoryId: 1, expectedRevision: 1, action: "leave_quarantined" },
    ], { verifiedBackup: true });
    expect(duplicate.ok).toBe(false);

    const stale = applySealedMigration(db, [
      { memoryId: 1, expectedRevision: 7, action: "leave_quarantined" },
    ], { verifiedBackup: true });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.refused).toContain("stale");

    const missing = applySealedMigration(db, [
      { memoryId: 1, expectedRevision: 1, action: "leave_quarantined" },
    ], { verifiedBackup: true });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.refused).toContain("no decision");

    // Nothing was written, revisions unchanged.
    const rows = db.prepare("SELECT id, semantic_revision, sealed_format_version FROM extracted_memories ORDER BY id").all() as Array<{ id: number; semantic_revision: number; sealed_format_version: number }>;
    expect(rows).toEqual([
      { id: 1, semantic_revision: 1, sealed_format_version: 0 },
      { id: 2, semantic_revision: 1, sealed_format_version: 0 },
    ]);
  });

  it("seals a plaintext legacy row into version 1; value leaves plaintext projections", () => {
    insertLegacyRow({ id: 1, contentEn: "the actual secret value", contentOriginal: "the actual secret value" });
    // FTS and trigram index the plaintext label — the trigger must replace it.
    db.prepare("INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (1, 'the actual secret value')").run();

    const outcome = applySealedMigration(db, [
      { memoryId: 1, expectedRevision: 1, action: "seal", label: "GitHub token", keyword: "github" },
    ], { verifiedBackup: true });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.sealed).toEqual([1]);
      expect(outcome.declassified).toEqual([]);
    }

    const row = db.prepare("SELECT content_en, content_original, encrypted, sealed_format_version, preserved_keyword FROM extracted_memories WHERE id = 1").get() as { content_en: string; content_original: string; encrypted: number; sealed_format_version: number; preserved_keyword: string | null };
    expect(row.content_en).toBe("GitHub token");
    expect(row.preserved_keyword).toBe("github");
    expect(row.encrypted).toBe(1);
    expect(row.sealed_format_version).toBe(1);
    expect(row.content_original).not.toContain("the actual secret value");
    expect(decrypt(row.content_original)).toBe("the actual secret value");

    // FTS now indexes the label, not the value.
    const labelHit = db.prepare("SELECT rowid FROM extracted_memories_fts WHERE content_en MATCH 'GitHub'").all();
    expect(labelHit.length).toBe(1);
    const valueHit = db.prepare("SELECT rowid FROM extracted_memories_fts WHERE content_en MATCH 'actual'").all();
    expect(valueHit.length).toBe(0);
  });

  it("declassifies to class 2 with an explicit non-sealed projection", () => {
    insertLegacyRow({ id: 1, encrypted: 1, sealedFormatVersion: 0, contentEn: "ciphertext-label", contentOriginal: "ciphertext-value" });

    const outcome = applySealedMigration(db, [
      { memoryId: 1, expectedRevision: 1, action: "declassify", classification: 2, contentEn: "public note", contentOriginal: "public detail" },
    ], { verifiedBackup: true });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.declassified).toEqual([1]);

    const row = db.prepare("SELECT content_en, content_original, encrypted, sealed_format_version, classification FROM extracted_memories WHERE id = 1").get() as { content_en: string; content_original: string; encrypted: number; sealed_format_version: number; classification: number };
    expect(row.classification).toBe(2);
    expect(row.encrypted).toBe(0);
    expect(row.sealed_format_version).toBe(0);
    expect(row.content_en).toBe("public note");
    expect(row.content_original).toBe("public detail");

    // The row is no longer a migration candidate.
    expect(inspectSealedMigration(db).candidates).toEqual([]);
  });

  it("leave_quarantined writes nothing and keeps the row undiscoverable at format 0", () => {
    insertLegacyRow({ id: 1, encrypted: 1, contentEn: "ciphertext", contentOriginal: "ciphertext" });

    const outcome = applySealedMigration(db, [
      { memoryId: 1, expectedRevision: 1, action: "leave_quarantined" },
    ], { verifiedBackup: true });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.quarantined).toEqual([1]);

    const row = db.prepare("SELECT sealed_format_version, encrypted, semantic_revision FROM extracted_memories WHERE id = 1").get() as { sealed_format_version: number; encrypted: number; semantic_revision: number };
    expect(row.sealed_format_version).toBe(0);
    expect(row.semantic_revision).toBe(1);
    expect(row.encrypted).toBe(1);
  });

  it("a seal decision for an already-encrypted legacy row decrypts and re-encrypts under the current key", () => {
    // Simulate a version-0 encrypted row: ciphertext under the current key.
    insertLegacyRow({ id: 1, encrypted: 1, contentEn: "cipher", contentOriginal: encrypt("real secret") });

    const outcome = applySealedMigration(db, [
      { memoryId: 1, expectedRevision: 1, action: "seal", label: "recovered credential" },
    ], { verifiedBackup: true });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.sealed).toEqual([1]);
    const row = db.prepare("SELECT content_original, content_en, encrypted, sealed_format_version FROM extracted_memories WHERE id = 1").get() as { content_original: string; content_en: string; encrypted: number; sealed_format_version: number };
    expect(decrypt(row.content_original)).toBe("real secret");
    expect(row.content_en).toBe("recovered credential");
    expect(row.encrypted).toBe(1);
    expect(row.sealed_format_version).toBe(1);
  });
});
