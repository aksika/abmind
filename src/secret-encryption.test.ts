import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeDatabase } from "./memory-db.js";
import { MemoryEditor } from "./memory-editor.js";
import { decrypt, _resetKeyCache } from "./crypto.js";
import { _resetAbmindEnv } from "./env-schema.js";
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

  it("stores classification=3 with encrypted content_original and plaintext content_en", async () => {
    const result = await editor.instantStore({
      userId: "test", contentEn: "OpenRouter API key", contentOriginal: "sk-or-v1-secret123",
      memoryType: "secret", emotionScore: 0, classification: 3,
    });
    expect(result.stored).toBe(true);

    const row = db.prepare("SELECT content_en, content_original, encrypted, memory_type FROM extracted_memories LIMIT 1")
      .get() as { content_en: string; content_original: string; encrypted: number; memory_type: string };
    expect(row.encrypted).toBe(1);
    expect(row.content_en).toBe("OpenRouter API key");
    expect(row.content_original).not.toBe("sk-or-v1-secret123");
    expect(decrypt(row.content_original)).toBe("sk-or-v1-secret123");
    expect(row.memory_type).toBe("secret");
  });

  it("stores classification<3 as plaintext", async () => {
    await editor.instantStore({
      userId: "test", contentEn: "normal fact", contentOriginal: "normal fact",
      memoryType: "fact", emotionScore: 0, classification: 1,
    });

    const row = db.prepare("SELECT content_en, encrypted FROM extracted_memories LIMIT 1")
      .get() as { content_en: string; encrypted: number };
    expect(row.encrypted).toBe(0);
    expect(row.content_en).toBe("normal fact");
  });

  it("encrypts content_original on promote to classification=3", async () => {
    await editor.instantStore({
      userId: "test", contentEn: "will be secret desc", contentOriginal: "the-actual-value",
      memoryType: "fact", emotionScore: 0, classification: 1,
    });

    const id = (db.prepare("SELECT id FROM extracted_memories LIMIT 1").get() as { id: number }).id;
    const result = editor.editMemory({ memoryId: id, classification: 3 });
    expect(result.ok).toBe(true);

    const row = db.prepare("SELECT content_en, content_original, encrypted FROM extracted_memories WHERE id = ?").get(id) as { content_en: string; content_original: string; encrypted: number };
    expect(row.encrypted).toBe(1);
    expect(row.content_en).toBe("will be secret desc");
    expect(decrypt(row.content_original)).toBe("the-actual-value");
  });

  it("keeps class=3 in FTS (description is searchable)", async () => {
    await editor.instantStore({
      userId: "test", contentEn: "unique-secret-description-xyz", contentOriginal: "hidden-value",
      memoryType: "secret", emotionScore: 0, classification: 3,
    });

    const fts = db.prepare("SELECT rowid FROM extracted_memories_fts WHERE content_en MATCH 'unique'").all();
    expect(fts.length).toBe(1);
  });

  it("refuses SECRET store when key generation fails", async () => {
    _resetKeyCache();
    _resetAbmindEnv();
    // Point to a read-only path that can't be created
    process.env["ABMIND_KEY_FILE"] = "/dev/null/impossible/no.key";
    _resetAbmindEnv();
    const result = await editor.instantStore({
      userId: "test", contentEn: "secret", contentOriginal: "secret",
      memoryType: "fact", emotionScore: 0, classification: 3,
    });
    expect(result.stored).toBe(false);
  });
});
