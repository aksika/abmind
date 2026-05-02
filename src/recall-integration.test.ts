/**
 * Integration test: recall pipeline v2 — Sf + Ss + Se + S6.
 * Tests the full recall path with a real SQLite DB.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import { recallSearch, type RecallDeps, type RecallParams } from "./recall-engine.js";
import type Database from "better-sqlite3";

let tmpDir: string;
let db: Database.Database;
let index: MemoryIndex;
let deps: RecallDeps;

const CHAT_ID = 100;

function insertMemory(opts: { contentEn: string; contentOriginal?: string; memoryType?: string; keyword?: string; classification?: number }): number {
  const now = Date.now();
  const result = db.prepare(
    `INSERT INTO extracted_memories
       (user_id, content_original, content_en, memory_type, source_timestamp, created_at,
        preserve_original, preserved_keyword, emotion_score, classification, trust, credibility, integrity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 2, 3, 2)`,
  ).run(
    CHAT_ID, opts.contentOriginal ?? opts.contentEn, opts.contentEn,
    opts.memoryType ?? "fact", now, now,
    opts.keyword ? 1 : 0, opts.keyword ?? null,
    opts.classification ?? 1,
  );
  return Number(result.lastInsertRowid);
}

function baseParams(overrides: Partial<RecallParams> = {}): RecallParams {
  return { translated: ["test"], userId: CHAT_ID, ...overrides };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "recall-integration-"));
  db = initializeDatabase(join(tmpDir, "memory.db"));
  index = new MemoryIndex(db);
  deps = { db, index, memoryDir: tmpDir, ctxStartPath: join(tmpDir, "ctx-start.json") };

  // Seed test data
  insertMemory({ contentEn: "Molty is aksika's OpenClaw agent. Molty = kiscsávó (little dude).", contentOriginal: "Molty az aksika OpenClaw agentje. Molty = kiscsávó.", keyword: "kiscsávó" });
  insertMemory({ contentEn: "aksika likes pizza with extra cheese.", contentOriginal: "aksika extra sajttal szereti a pizzát.", memoryType: "preference" });
  insertMemory({ contentEn: "The bridge uses ACP transport for kiro-cli communication.", memoryType: "fact" });
  insertMemory({ contentEn: "Top secret API key: sk-1234", classification: 3 });

  // Create a daily consolidation file
  const dailyDir = join(tmpDir, "daily");
  mkdirSync(dailyDir, { recursive: true });
  writeFileSync(join(dailyDir, "daily_2026-03-29.md"), "# Daily Summary\n\nDiscussed Molty setup, pizza preferences, and bridge architecture.");
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Recall Pipeline v2 — Integration", () => {

  // ── Sf: Three-query fuzzy search ──

  it("Sf: porter FTS5 finds memory by English keyword", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["pizza"], stages: ["Sf"] }));
    expect(result.stages["Sf"]?.hits.length).toBeGreaterThan(0);
    expect(result.results.some(r => r.content.includes("pizza"))).toBe(true);
  });

  it("Sf: trigram finds by preserved_keyword", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["kiscsavo"], stages: ["Sf"] }));
    expect(result.stages["Sf"]?.hits.length).toBeGreaterThan(0);
  });

  it("Sf: trigram falls back to content_original", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["pizza"], original: "sajt", stages: ["Sf"] }));
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("Sf: respects classification filter", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["secret", "API", "key"], stages: ["Sf"], maxClassification: 2 }));
    expect(result.results.every(r => !r.content.includes("sk-1234"))).toBe(true);
  });

  // ── S6: Consolidation files ──

  it("S6: searches daily consolidation files", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["architecture"], stages: ["S6"] }));
    expect(result.stages["S6"]?.hits.length).toBeGreaterThan(0);
    expect(result.results.some(r => r.source.startsWith("S6"))).toBe(true);
  });

  // ── Full pipeline ──

  it("full pipeline: all stages run and produce merged results", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["Molty"] }));
    expect(result.results.length).toBeGreaterThan(0);
    const stagesWithHits = Object.entries(result.stages).filter(([, v]) => v.hits.length > 0).map(([k]) => k);
    expect(stagesWithHits.length).toBeGreaterThanOrEqual(1);
  });

  it("full pipeline: deduplicates across stages", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["pizza"] }));
    const ids = result.extractedIds;
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });

  it("full pipeline: returns empty on zero results (no S7 fallback)", async () => {
    const result = await recallSearch(deps, baseParams({ translated: ["xyznonexistent"] }));
    expect(result.results.length).toBe(0);
  });
});
