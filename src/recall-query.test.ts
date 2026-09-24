/**
 * recall-query.test.ts — #1836 Sf probe set replay (real SQLite, no embeddings).
 *
 * A whole-message single-phrase query must still land keyword rows in the Sf
 * pool via per-term trigram rescue (porter cannot bridge agglutinative
 * suffixes), rescue runs even when the pool is not thin, probe counts stay
 * bounded, and focused multi-keyword inputs keep their existing path. All
 * fixture text is synthetic.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import { trigramSearch, extractSignificantTerms, type SfOptions } from "./trigram-search.js";

const USER = "u1";

let tmpDir: string;
let db: Database.Database;
const ids: Record<string, number> = {};

function insert(key: string, content: string): void {
  const now = Date.now();
  const r = db.prepare(
    `INSERT INTO extracted_memories
       (user_id, content_original, content_en, memory_type, source_timestamp, created_at,
        preserve_original, preserved_keyword, emotion_score, classification, trust, credibility, integrity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(USER, content, content, "fact", now, now, 0, null, 0, 1, 2, 3, 2);
  ids[key] = Number(r.lastInsertRowid);
}

function opts(translated: string[], limit = 10): SfOptions {
  return { translated, userId: USER, limit, maxClassification: 2 };
}

function poolIds(translated: string[], limit = 10): Set<number> {
  return new Set(
    trigramSearch(db, opts(translated, limit)).hits
      .map((h) => h.id)
      .filter((id): id is number => id !== undefined),
  );
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "recall-query-1836-"));
  db = initializeDatabase(join(tmpDir, "memory.db"));
  insert("gyula1", "Niki from Gyula keeps a dog");
  insert("gyula2", "Benedek walked his dog past the Gyula cinema");
  insert("teso", "Teso greeted everyone at noon");
  insert("other", "Dashboard colors are blue");
  insert("quote", "Word for word quote here today");
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("extractSignificantTerms", () => {
  it("keeps unicode runs over 2 chars in order, dedups, caps at 8", () => {
    const terms = extractSignificantTerms(["Szoval hany gyulait ismersz Teso", "Teso Gyula"]);
    expect(terms).toEqual(["Szoval", "hany", "gyulait", "ismersz", "Teso", "Gyula"]);
    const many = extractSignificantTerms([Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ")]);
    expect(many).toHaveLength(8);
    expect(extractSignificantTerms(["a be to it"])).toEqual([]);
  });
});

describe("#1836 raw-message probe set", () => {
  it("lands inflected keyword rows in the Sf pool via rescue, not porter", async () => {
    const pool = poolIds(["Szoval hany gyulait ismersz Teso"]);
    expect(pool.has(ids["gyula1"]!)).toBe(true);
    expect(pool.has(ids["gyula2"]!)).toBe(true);
  });

  it("rescue runs even when unrelated OR hits already fill the pool", async () => {
    // limit 1: the Teso OR hit alone fills the thin-pool gate, yet Gyula rows
    // must still arrive through per-term rescue.
    const pool = poolIds(["Szoval hany gyulait ismersz Teso"], 1);
    expect(pool.has(ids["gyula1"]!)).toBe(true);
    expect(pool.has(ids["gyula2"]!)).toBe(true);
  });

  it("keeps the exact-phrase porter probe first", async () => {
    const { hits } = trigramSearch(db, opts(["Word for word quote here today"]));
    const hit = hits.find((h) => h.id === ids["quote"]);
    expect(hit).toBeDefined();
    expect(hit!.source).toBe("Sf:porter");
  });

  it("focused multi-keyword inputs keep the existing path", async () => {
    const pool = poolIds(["Gyula", "dog"]);
    expect(pool.has(ids["gyula1"]!)).toBe(true);
    expect(pool.has(ids["gyula2"]!)).toBe(true);
  });

  it("pool stays bounded for long messages", async () => {
    const longMsg = "Gyula " + Array.from({ length: 40 }, (_, i) => `padding${i}`).join(" ");
    const { hits } = trigramSearch(db, opts([longMsg]));
    // 2 porter probes (fetchLimit 30 each) + 8 terms x 2 tables x per-term cap 5.
    expect(hits.length).toBeLessThanOrEqual(30 + 30 + 8 * 2 * 5);
    expect(hits.some((h) => h.id === ids["gyula1"]!)).toBe(true);
  });

  it("one term cannot exceed its per-term add cap", async () => {
    // 20 rows share the substring window of one inflected term; rescue may add
    // at most RESCUE_PER_TERM_CAP per table (EN + original) for that term.
    for (let i = 0; i < 20; i++) insert(`flood${i}`, `gyulait seminar note number ${i}`);
    const { hits } = trigramSearch(db, opts(["gyulaitinak kerelem"], 50));
    const added = hits.filter((h) => h.content.includes("seminar")).length;
    expect(added).toBeLessThanOrEqual(10);
  });
});
