/**
 * recall-ranking.test.ts — #1835 synthetic SQLite replay for the ranking fix.
 *
 * Real database plus scripted 3-dim embeddings: asserts stage pools versus
 * final order (retrieved-but-lost is the bug), strong-literal floors, weak
 * validation demotion incl. short-circuit and timeout paths, and gentle age
 * fade with emotion resistance. Membership and rank bounds only, never exact
 * scores. All fixture text is synthetic.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import { recallSearch, isStrongLexicalMatch, type RecallDeps, type RecallParams } from "./recall-engine.js";
import { _resetAbmindEnv } from "./env-schema.js";

const USER = "u1";
const DAY = 86400000;

let tmpDir: string;
let db: Database.Database;
let deps: RecallDeps;
const ids: Record<string, number> = {};

function vecBuf(v: number[]): Buffer {
  return Buffer.from(new Float32Array(v).buffer);
}

function insert(opts: {
  key: string; content: string; ageDays?: number; emotion?: number; vec?: number[];
}): void {
  const created = Date.now() - (opts.ageDays ?? 0) * DAY;
  const r = db.prepare(
    `INSERT INTO extracted_memories
       (user_id, content_original, content_en, memory_type, source_timestamp, created_at,
        preserve_original, preserved_keyword, emotion_score, classification, trust, credibility, integrity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(USER, opts.content, opts.content, "fact", created, created, 0, null, opts.emotion ?? 0, 1, 2, 3, 2);
  const id = Number(r.lastInsertRowid);
  ids[opts.key] = id;
  if (opts.vec) db.prepare(`UPDATE extracted_memories SET embedding = ? WHERE id = ?`).run(vecBuf(opts.vec), id);
}

const LOW = [0.15, 0.9, 0.42]; // cosine ~0.15 to Q: below Se threshold and validation floor
const NEAR = [0.95, 0.2, 0.1]; // cosine ~0.97 to Q: Se-retrieved noise
const Q = new Float32Array([1, 0, 0]);

function provider(vector: Float32Array | null, delayMs = 0): RecallDeps["embeddingProvider"] {
  return {
    name: "test-scripted",
    dimensions: 3,
    embedText: async () =>
      delayMs > 0 ? new Promise<Float32Array | null>((res) => setTimeout(() => res(vector), delayMs)) : vector,
    batchEmbed: async () => [],
  };
}

function params(overrides: Partial<RecallParams> = {}): RecallParams {
  return { translated: ["Gyula", "dog"], userId: USER, limit: 10, ...overrides };
}

function scoreOf(result: { results: Array<{ id?: number; score: number }> }, key: string): number | null {
  const hit = result.results.find((h) => h.id === ids[key]);
  return hit ? hit.score : null;
}

function rankOf(result: { results: Array<{ id?: number }> }, key: string): number {
  return result.results.findIndex((h) => h.id === ids[key]);
}

beforeAll(() => {
  _resetAbmindEnv();
  tmpDir = mkdtempSync(join(tmpdir(), "recall-ranking-1835-"));
  db = initializeDatabase(join(tmpDir, "memory.db"));
  deps = { db, index: new MemoryIndex(db), memoryDir: tmpDir, embeddingProvider: provider(Q) };

  insert({ key: "g1", content: "Niki from Gyula keeps a dog", vec: LOW });
  insert({ key: "g2", content: "Benedek walked his dog past the Gyula cinema", vec: LOW });
  insert({ key: "g3", content: "Szasz family from Gyula brought dog treats", vec: LOW });
  insert({ key: "gOld", content: "Attila trained the Gyula police dog unit", ageDays: 200, vec: LOW });
  insert({ key: "gEmo", content: "Petra rescued the Gyula stray dog", ageDays: 200, emotion: 4, vec: LOW });
  insert({ key: "overlap", content: "Gyula dog show awards ceremony", vec: NEAR });
  insert({ key: "weak", content: "A dog barked at the night train", vec: LOW });
  insert({ key: "n1", content: "Morning briefing tone is friendly", vec: NEAR });
  insert({ key: "n2", content: "Spanish lessons continue tomorrow", vec: NEAR });
  insert({ key: "n3", content: "Dashboard colors are blue", vec: NEAR });
});

afterAll(() => {
  delete process.env["RECALL_VALIDATE_WAIT_MS"];
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("isStrongLexicalMatch", () => {
  it("needs every keyword, case-insensitive; empty query never strong", () => {
    expect(isStrongLexicalMatch("Niki from Gyula keeps a dog", ["gyula", "DOG"])).toBe(true);
    expect(isStrongLexicalMatch("A dog barked", ["gyula", "dog"])).toBe(false);
    expect(isStrongLexicalMatch("anything", [])).toBe(false);
  });
});

describe("#1835 rank fusion replay", () => {
  it("Sf pool holds every exact match (retrieval is not the bug)", async () => {
    const res = await recallSearch(deps, params());
    const pool = new Set((res.stages["Sf"]?.hits ?? []).map((h) => h.id));
    for (const k of ["g1", "g2", "g3", "gOld", "gEmo", "overlap", "weak"]) {
      expect(pool.has(ids[k])).toBe(true);
    }
  });

  it("strong exacts outrank embedding-only noise in the final order", async () => {
    const res = await recallSearch(deps, params());
    // Plan acceptance is top-k membership, not total order: MMR may legitimately
    // diversify one near-duplicate below a noise hit.
    const strongIds = new Set(["g1", "g2", "g3", "gOld", "gEmo", "overlap"].map((k) => ids[k]));
    expect(strongIds.has(res.results[0]?.id)).toBe(true);
    for (const k of ["g1", "g2", "g3", "gOld", "gEmo", "overlap"]) {
      const r = rankOf(res, k);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(7);
    }
  });

  it("weak partial lexical hit is validated down below every strong", async () => {
    const res = await recallSearch(deps, params());
    const weakScore = scoreOf(res, "weak");
    expect(weakScore).not.toBeNull();
    expect(weakScore!).toBeLessThan(0.5);
    for (const k of ["g1", "g2", "g3", "gOld", "gEmo", "overlap"]) {
      expect(rankOf(res, k)).toBeLessThan(rankOf(res, "weak"));
    }
  });

  it("old neutral strong fades slightly, old emotional strong resists, both beat new noise", async () => {
    const res = await recallSearch(deps, params());
    const oldScore = scoreOf(res, "gOld")!;
    const emoScore = scoreOf(res, "gEmo")!;
    expect(oldScore).not.toBeNull();
    expect(emoScore).toBeGreaterThanOrEqual(oldScore);
    const noiseBest = Math.max(
      ...( ["n1", "n2", "n3"].map((k) => scoreOf(res, k) ?? -Infinity)),
    );
    expect(oldScore).toBeGreaterThan(noiseBest);
  });

  it("short-circuit still validates: weak demoted, no skipped flag", async () => {
    const res = await recallSearch(deps, params({ limit: 2 }));
    expect(res.shortCircuitAfter).toBe("Sf");
    expect(res.results.some((h) => h.id === ids["weak"])).toBe(false);
    expect(res.stages["Se"]?.validationSkipped ?? false).toBe(false);
  });

  it("validation timeout keeps lexical order and records the skip", async () => {
    // Short-circuit path: Se is skipped, so the embedding is still pending at
    // merge time and the deadline race is real (without short-circuit, Se
    // already awaited the full promise and a timeout could never fire).
    process.env["RECALL_VALIDATE_WAIT_MS"] = "20";
    try {
      const slowDeps: RecallDeps = { ...deps, embeddingProvider: provider(Q, 150) };
      const t0 = Date.now();
      const res = await recallSearch(slowDeps, params({ limit: 3 }));
      // The deadline is the proof: recall returns without waiting 150ms.
      expect(Date.now() - t0).toBeLessThan(100);
      expect(res.shortCircuitAfter).toBe("Sf");
      expect(res.stages["Se"]?.validationSkipped).toBe(true);
      const weakScore = scoreOf(res, "weak");
      expect(weakScore === null || weakScore > 0.55).toBe(true);
    } finally {
      delete process.env["RECALL_VALIDATE_WAIT_MS"];
    }
  });
});
