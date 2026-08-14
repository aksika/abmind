import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeDatabase } from "./memory-db.js";
import { IngestPipeline } from "./ingest-pipeline.js";
import type Database from "better-sqlite3";

describe("#1658 Master-only ingest gate", () => {
  let tmpDir: string;
  let db: Database.Database;
  let pipeline: IngestPipeline;
  let savedUserId: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ingest-gate-"));
    db = initializeDatabase(join(tmpDir, "memory.db"));
    pipeline = new IngestPipeline(db);
    savedUserId = process.env.ABMIND_USER_ID;
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedUserId === undefined) delete process.env.ABMIND_USER_ID;
    else process.env.ABMIND_USER_ID = savedUserId;
  });

  function metadata(userId: string) {
    return {
      userId,
      sourceType: "local_file" as const,
      identifier: "doc-1",
      trust: 1,
      classification: 1,
    };
  }

  it("ingests under the canonical primary identity and writes both tables", () => {
    process.env.ABMIND_USER_ID = "master-user";
    const result = pipeline.ingest("master content", metadata("master-user"));
    expect(result.ingested).toBe(true);
    expect(result.refused).toBeUndefined();
    const memoryCount = (db.prepare("SELECT COUNT(*) AS c FROM extracted_memories").get() as { c: number }).c;
    const docCount = (db.prepare("SELECT COUNT(*) AS c FROM ingested_documents").get() as { c: number }).c;
    expect(memoryCount).toBe(1);
    expect(docCount).toBe(1);
    expect((db.prepare("SELECT user_id FROM extracted_memories").get() as { user_id: string }).user_id).toBe("master-user");
  });

  it("refuses a foreign owner and writes neither table", () => {
    process.env.ABMIND_USER_ID = "master-user";
    const result = pipeline.ingest("foreign content", metadata("foreign-user"));
    expect(result.ingested).toBe(false);
    expect(result.refused).toBe(true);
    if (result.refused) expect(result.reason).toContain("non_primary_memory_owner");
    expect((db.prepare("SELECT COUNT(*) AS c FROM extracted_memories").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM ingested_documents").get() as { c: number }).c).toBe(0);
  });

  it("refuses a missing identity and writes neither table", () => {
    delete process.env.ABMIND_USER_ID;
    const result = pipeline.ingest("orphan content", metadata("nobody"));
    expect(result.ingested).toBe(false);
    expect(result.refused).toBe(true);
    if (result.refused) expect(result.reason).toContain("primary_identity_missing");
    expect((db.prepare("SELECT COUNT(*) AS c FROM extracted_memories").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM ingested_documents").get() as { c: number }).c).toBe(0);
  });

  it("normal skipped results are not refused", () => {
    process.env.ABMIND_USER_ID = "master-user";
    const first = pipeline.ingest("dedup me", metadata("master-user"));
    expect(first.ingested).toBe(true);
    // Backdate the ingest record so the second call hits dedup, not rate-limit.
    db.prepare("UPDATE ingested_documents SET ingested_at = 0").run();
    const second = pipeline.ingest("dedup me", metadata("master-user"));
    expect(second.skipped).toBe(true);
    expect(second.refused).toBeUndefined();
    expect(second.reason).toBe("already_ingested");
  });

  describe("#1660 sealed class-3 ingest", () => {
    let savedKeyFile: string | undefined;

    beforeEach(() => {
      savedKeyFile = process.env.ABMIND_KEY_FILE;
      process.env.ABMIND_KEY_FILE = join(tmpDir, "test.key");
    });

    afterEach(() => {
      if (savedKeyFile === undefined) delete process.env.ABMIND_KEY_FILE;
      else process.env.ABMIND_KEY_FILE = savedKeyFile;
    });

    it("seals class-3 ingest: label in content_en, ciphertext in content_original", () => {
      process.env.ABMIND_USER_ID = "master-user";
      const result = pipeline.ingest("super-secret-exact-value", {
        ...metadata("master-user"),
        classification: 3,
        sealedLabel: "internal sync token",
      });
      expect(result.ingested).toBe(true);
      const row = db.prepare("SELECT content_en, content_original, encrypted, sealed_format_version, memory_type FROM extracted_memories").get() as { content_en: string; content_original: string; encrypted: number; sealed_format_version: number; memory_type: string };
      expect(row.content_en).toBe("internal sync token");
      expect(row.content_original).not.toContain("super-secret-exact-value");
      expect(row.encrypted).toBe(1);
      expect(row.sealed_format_version).toBe(1);
    });

    it("refuses class-3 ingest without a sealed label and writes neither table", () => {
      process.env.ABMIND_USER_ID = "master-user";
      const result = pipeline.ingest("super-secret-exact-value", {
        ...metadata("master-user"),
        classification: 3,
      });
      expect(result.ingested).toBe(false);
      expect(result.refused).toBe(true);
      expect(result.reason).toContain("sealedLabel");
      expect((db.prepare("SELECT COUNT(*) AS c FROM extracted_memories").get() as { c: number }).c).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS c FROM ingested_documents").get() as { c: number }).c).toBe(0);
    });
  });
});
