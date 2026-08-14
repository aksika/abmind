import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cosineSimilarity, vectorSearch, loadEmbedConfig } from "./ollama-embed.js";

// ── cosineSimilarity ────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity(new Float32Array([]), new Float32Array([]))).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity(new Float32Array([1]), new Float32Array([1, 2]))).toBe(0);
  });

  it("returns 0 for zero vector", () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 2]))).toBe(0);
  });
});

// ── vectorSearch ────────────────────────────────────────────────────────────

describe("vectorSearch", () => {
  function makeVec(...vals: number[]): Buffer {
    return Buffer.from(new Float32Array(vals).buffer);
  }

  function mockDb(rows: unknown[] = []) {
    return { prepare: vi.fn(() => ({ all: vi.fn(() => rows) })) } as any;
  }

  it("returns results above threshold sorted by score", () => {
    const query = new Float32Array([1, 0, 0]);
    const db = mockDb([
      { id: 1, content_en: "close", content_original: null, created_at: 1000, memory_type: "fact", embedding: makeVec(0.9, 0.1, 0), trust: 5, integrity: 5, credibility: 5, classification: 0, source_message_ids: null },
      { id: 2, content_en: "far", content_original: null, created_at: 2000, memory_type: "fact", embedding: makeVec(0, 1, 0), trust: 5, integrity: 5, credibility: 5, classification: 0, source_message_ids: null },
    ]);
    const results = vectorSearch(db, query, { threshold: 0.5 });
    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe(1);
    expect(results[0]!.score).toBeGreaterThan(0.5);
  });

  it("returns empty when no results above threshold", () => {
    const query = new Float32Array([1, 0]);
    const db = mockDb([
      { id: 1, content_en: "x", content_original: null, created_at: 1000, memory_type: "fact", embedding: makeVec(0, 1), trust: null, integrity: null, credibility: null, classification: null, source_message_ids: null },
    ]);
    const results = vectorSearch(db, query, { threshold: 0.9 });
    expect(results.length).toBe(0);
  });

  it("respects limit", () => {
    const query = new Float32Array([1, 0]);
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: i, content_en: `m${i}`, content_original: null, created_at: i * 1000,
      memory_type: "fact", embedding: makeVec(1, 0.01 * i), trust: null, integrity: null,
      credibility: null, classification: null, source_message_ids: null,
    }));
    const db = mockDb(rows);
    const results = vectorSearch(db, query, { threshold: 0, limit: 3 });
    expect(results.length).toBe(3);
  });

  it("filters by userId and maxClassification", () => {
    const db = mockDb([]);
    vectorSearch(db, new Float32Array([1]), { userId: "user-123", maxClassification: 1, threshold: 0.5 });
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(sql).toContain("user_id = ?");
    expect(sql).toContain("classification");
  });
});

import { _resetAbmindEnv } from "./env-schema.js";

// ── loadEmbedConfig ─────────────────────────────────────────────────────────

describe("loadEmbedConfig", () => {
  beforeEach(() => {
    _resetAbmindEnv();
    delete process.env["EMBEDDING_ENABLED"];
    delete process.env["EMBEDDING_MODEL"];
    delete process.env["EMBEDDING_URL"];
    delete process.env["EMBEDDING_SIMILARITY_THRESHOLD"];
  });

  afterEach(() => { _resetAbmindEnv(); });

  it("defaults to enabled", () => {
    expect(loadEmbedConfig().enabled).toBe(true);
  });

  it("reads env vars", () => {
    process.env["EMBEDDING_ENABLED"] = "true";
    process.env["EMBEDDING_MODEL"] = "custom-model";
    process.env["EMBEDDING_URL"] = "http://custom:1234";
    process.env["EMBEDDING_SIMILARITY_THRESHOLD"] = "0.8";
    const cfg = loadEmbedConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.model).toBe("custom-model");
    expect(cfg.url).toBe("http://custom:1234");
    expect(cfg.threshold).toBe(0.8);
  });
});

// ── #1660 batchEmbed class-3 exclusion ──────────────────────────────────────

describe("batchEmbed sealed exclusion", () => {
  it("never embeds class-3 rows during backfill (embedding stays NULL)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { initializeDatabase } = await import("./memory-db.js");
    const { batchEmbed } = await import("./ollama-embed.js");
    const dir = mkdtempSync(join(tmpdir(), "embed-excl-"));
    const db = initializeDatabase(join(dir, "memory.db"));
    try {
      db.prepare(
        `INSERT INTO extracted_memories
           (user_id, content_original, content_en, memory_type, source_timestamp,
            created_at, classification, encrypted, sealed_format_version)
         VALUES (?, ?, ?, 'fact', ?, ?, ?, ?, ?)`,
      ).run("u1", "ciphertext", "label one", 1000, 1000, 1, 0, 0);
      db.prepare(
        `INSERT INTO extracted_memories
           (user_id, content_original, content_en, memory_type, source_timestamp,
            created_at, classification, encrypted, sealed_format_version)
         VALUES (?, ?, ?, 'fact', ?, ?, ?, ?, ?)`,
      ).run("u1", "ciphertext-sealed", "sealed label", 2000, 2000, 3, 1, 1);

      const config = { enabled: true, model: "m", url: "http://127.0.0.1:1", threshold: 0.5 };
      // Point at an unreachable embed endpoint so the only rows that could be
      // "embedded" are the un-sealed one; the class-3 row must never be
      // selected at all.
      const count = await batchEmbed(config, db);
      const sealedRow = db.prepare("SELECT embedding FROM extracted_memories WHERE classification = 3").get() as { embedding: Buffer | null };
      expect(sealedRow.embedding).toBeNull();
      expect(count).toBe(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
