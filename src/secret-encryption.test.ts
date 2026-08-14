import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeDatabase } from "./memory-db.js";
import { MemoryEditor } from "./memory-editor.js";
import { decrypt, _resetKeyCache } from "./crypto.js";
import { _resetAbmindEnv } from "./env-schema.js";
import { SEALED_FORMAT_VERSION } from "./sealed-memory.js";
import type Database from "better-sqlite3";

describe("SECRET memory encryption", () => {
  let tmpDir: string;

  let db: Database.Database;
  let editor: MemoryEditor;

  beforeEach(() => {
    _resetKeyCache();
    _resetAbmindEnv();
    tmpDir = mkdtempSync(join(tmpdir(), "abmind-secret-"));
    process.env["ABMIND_KEY_FILE"] = join(tmpDir, "test.key");
    process.env.ABMIND_USER_ID = "test";
    _resetAbmindEnv();
    db = initializeDatabase(join(tmpDir, "memory.db"));
    editor = new MemoryEditor(db);
  });

  afterEach(() => {
    db.close();
    _resetKeyCache();
    delete process.env["ABMIND_KEY_FILE"];
    _resetAbmindEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores classification=3 as a version-1 sealed row: label in content_en, ciphertext in content_original", async () => {
    const result = await editor.instantStore({
      userId: "test", contentOriginal: "sk-or-v1-secret123",
      sealedLabel: "OpenRouter API key",
      memoryType: "secret", emotionScore: 0, classification: 3,
    });
    expect(result.stored).toBe(true);

    const row = db.prepare("SELECT content_en, content_original, encrypted, sealed_format_version, embedding, memory_type FROM extracted_memories LIMIT 1")
      .get() as { content_en: string; content_original: string; encrypted: number; sealed_format_version: number; embedding: Buffer | null; memory_type: string };
    expect(row.encrypted).toBe(1);
    expect(row.sealed_format_version).toBe(SEALED_FORMAT_VERSION);
    expect(row.content_en).toBe("OpenRouter API key");
    expect(row.content_original).not.toBe("sk-or-v1-secret123");
    expect(decrypt(row.content_original)).toBe("sk-or-v1-secret123");
    expect(row.embedding).toBeNull();
    expect(row.memory_type).toBe("secret");
  });

  it("stores classification<3 as plaintext", async () => {
    await editor.instantStore({
      userId: "test", contentEn: "normal fact", contentOriginal: "normal fact",
      memoryType: "fact", emotionScore: 0, classification: 1,
    });

    const row = db.prepare("SELECT content_en, encrypted, sealed_format_version FROM extracted_memories LIMIT 1")
      .get() as { content_en: string; encrypted: number; sealed_format_version: number };
    expect(row.encrypted).toBe(0);
    expect(row.sealed_format_version).toBe(0);
    expect(row.content_en).toBe("normal fact");
  });

  it("requires sealedLabel for class-3 store and refuses without partial writes", async () => {
    const result = await editor.instantStore({
      userId: "test", contentEn: "OpenRouter API key", contentOriginal: "sk-or-v1-secret123",
      memoryType: "secret", emotionScore: 0, classification: 3,
    });
    expect(result.stored).toBe(false);
    const count = db.prepare("SELECT COUNT(*) as c FROM extracted_memories").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("rejects a sealed label that duplicates or contains the exact value", async () => {
    const dup = await editor.instantStore({
      userId: "test", contentOriginal: "sk-or-v1-secret123",
      sealedLabel: "sk-or-v1-secret123",
      memoryType: "secret", emotionScore: 0, classification: 3,
    });
    expect(dup.stored).toBe(false);

    const contains = await editor.instantStore({
      userId: "test", contentOriginal: "sk-or-v1-secret123",
      sealedLabel: "my key sk-or-v1-secret123 is important",
      memoryType: "secret", emotionScore: 0, classification: 3,
    });
    expect(contains.stored).toBe(false);
    const count = db.prepare("SELECT COUNT(*) as c FROM extracted_memories").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("promotes to classification=3 only with sealedLabel, producing a sealed row", async () => {
    await editor.instantStore({
      userId: "test", contentEn: "will be secret desc", contentOriginal: "the-actual-value",
      memoryType: "fact", emotionScore: 0, classification: 1,
    });

    const id = (db.prepare("SELECT id FROM extracted_memories LIMIT 1").get() as { id: number }).id;

    const withoutLabel = editor.editMemory({ memoryId: id, classification: 3 });
    expect(withoutLabel.ok).toBe(false);

    const result = editor.editMemory({ memoryId: id, classification: 3, sealedLabel: "will be secret desc" });
    expect(result.ok).toBe(true);

    const row = db.prepare("SELECT content_en, content_original, encrypted, sealed_format_version, embedding FROM extracted_memories WHERE id = ?").get(id) as { content_en: string; content_original: string; encrypted: number; sealed_format_version: number; embedding: Buffer | null };
    expect(row.encrypted).toBe(1);
    expect(row.sealed_format_version).toBe(SEALED_FORMAT_VERSION);
    expect(row.content_en).toBe("will be secret desc");
    expect(decrypt(row.content_original)).toBe("the-actual-value");
    expect(row.embedding).toBeNull();
  });

  it("declassifies a sealed row only with capability and an explicit projection", async () => {
    const store = await editor.instantStore({
      userId: "test", contentOriginal: "the-value", sealedLabel: "the-label",
      memoryType: "secret", emotionScore: 0, classification: 3,
    });
    expect(store.stored).toBe(true);
    const id = (store as { memoryId: number }).memoryId;

    const withoutOverride = editor.editMemory({ memoryId: id, classification: 1, contentEn: "label text", contentOriginal: "plain value" });
    expect(withoutOverride.ok).toBe(false);

    const result = editor.editMemory({ memoryId: id, classification: 1, contentEn: "label text", contentOriginal: "plain value", userOverride: true });
    expect(result.ok).toBe(true);

    const row = db.prepare("SELECT content_en, content_original, encrypted, sealed_format_version FROM extracted_memories WHERE id = ?").get(id) as { content_en: string; content_original: string; encrypted: number; sealed_format_version: number };
    expect(row.encrypted).toBe(0);
    expect(row.sealed_format_version).toBe(0);
    expect(row.content_en).toBe("label text");
    expect(row.content_original).toBe("plain value");
  });

  it("keeps class-3 label searchable via FTS (description is searchable, value is not)", async () => {
    await editor.instantStore({
      userId: "test", contentOriginal: "hidden-value",
      sealedLabel: "unique-secret-description-xyz",
      memoryType: "secret", emotionScore: 0, classification: 3,
    });

    const fts = db.prepare("SELECT rowid FROM extracted_memories_fts WHERE content_en MATCH 'unique'").all();
    expect(fts.length).toBe(1);
    const noValue = db.prepare("SELECT rowid FROM extracted_memories_fts WHERE content_en MATCH 'hidden'").all();
    expect(noValue.length).toBe(0);
  });

  it("stores same-label class-3 rows as distinct rows (label is not identity)", async () => {
    const first = await editor.instantStore({
      userId: "test", contentOriginal: "value-one", sealedLabel: "same label",
      memoryType: "secret", emotionScore: 0, classification: 3,
    });
    const second = await editor.instantStore({
      userId: "test", contentOriginal: "value-two", sealedLabel: "same label",
      memoryType: "secret", emotionScore: 0, classification: 3,
    });
    expect(first.stored).toBe(true);
    expect(second.stored).toBe(true);
    const rows = db.prepare("SELECT id, content_original FROM extracted_memories ORDER BY id").all() as Array<{ id: number; content_original: string }>;
    expect(rows.length).toBe(2);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
    expect(decrypt(rows[0]!.content_original)).toBe("value-one");
    expect(decrypt(rows[1]!.content_original)).toBe("value-two");
  });

  it("rotates a sealed value via explicit CAS edit without changing the label", async () => {
    const store = await editor.instantStore({
      userId: "test", contentOriginal: "old-value", sealedLabel: "stable label",
      memoryType: "secret", emotionScore: 0, classification: 3,
    });
    const id = (store as { memoryId: number }).memoryId;
    const rev = (store as { semanticRevision: number }).semanticRevision;

    const rotated = editor.editMemory({ memoryId: id, expectedRevision: rev, contentOriginal: "new-value" });
    expect(rotated.ok).toBe(true);

    const row = db.prepare("SELECT content_original, content_en, encrypted, sealed_format_version FROM extracted_memories WHERE id = ?").get(id) as { content_original: string; content_en: string; encrypted: number; sealed_format_version: number };
    expect(decrypt(row.content_original)).toBe("new-value");
    expect(row.content_en).toBe("stable label");
    expect(row.encrypted).toBe(1);
    expect(row.sealed_format_version).toBe(SEALED_FORMAT_VERSION);
  });

  it("refuses clearContentOriginal on a sealed row (TTL aging cannot strip the value)", async () => {
    const store = await editor.instantStore({
      userId: "test", contentOriginal: "the-value", sealedLabel: "the-label",
      memoryType: "secret", emotionScore: 0, classification: 3,
    });
    const id = (store as { memoryId: number }).memoryId;
    const rev = (store as { semanticRevision: number }).semanticRevision;

    // TTL aging clears originals through this single edit path; a sealed row
    // must refuse it without stripping the value.
    const storeResult = editor.getMutationStore().edit(
      { userId: "test", actorId: "maintenance:test", operationKey: "clear-sealed", canDeclassifySecret: false, origin: "internal" },
      { userId: "test", memoryId: id, expectedRevision: rev, clearContentOriginal: true },
    );
    expect(storeResult.ok).toBe(false);
    expect(storeResult.code).toBe("validation_error");
    const row = db.prepare("SELECT content_original FROM extracted_memories WHERE id = ?").get(id) as { content_original: string };
    expect(decrypt(row.content_original)).toBe("the-value");
  });

  it("refuses SECRET store when key generation fails", async () => {
    _resetKeyCache();
    _resetAbmindEnv();
    // Point to a read-only path that can't be created
    process.env["ABMIND_KEY_FILE"] = "/dev/null/impossible/no.key";
    _resetAbmindEnv();
    const result = await editor.instantStore({
      userId: "test", contentOriginal: "secret", sealedLabel: "label",
      memoryType: "fact", emotionScore: 0, classification: 3,
    });
    expect(result.stored).toBe(false);
  });
});
