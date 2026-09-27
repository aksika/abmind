/**
 * #1861 — full-history Se/Ss coverage and coverage-aware Sf ordering.
 *
 * Real temporary memory DB with deterministic vectors and signatures; no live
 * embedding service and no private memory text. Regression shapes:
 * - an eligible target behind 500+ newer records reaches fusion through its
 *   stored vector, both for an exact lexical query and for a paraphrase,
 * - Ss considers signed rows older than the removed newest-500 window,
 * - highly similar but inaccessible rows neither leak nor crowd out an
 *   eligible older candidate,
 * - Sf ranks token-boundary topical matches above stemming-only collisions
 *   and mid-token substring distractors.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import { recallSearch, type RecallDeps } from "./recall-engine.js";
import { generateSignature } from "./signature-generator.js";
import { hasTokenBoundaryMatch } from "./trigram-search.js";
import { initVec, vecAvailable } from "./ollama-embed.js";
import { requireNativeDep } from "../cli/lib/native-dep.js";

const USER = "u1";
const FOREIGN = "foreign-user";
const DAY = 86400000;
const Q = new Float32Array([1, 0, 0]);

function nativeVecAvailable(): boolean {
  try { requireNativeDep("sqlite-vec"); return true; } catch { return false; }
}

function vec(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

type Fixture = {
  db: Database.Database;
  deps: RecallDeps;
  close: () => void;
};

function makeFixture(embedding?: Float32Array): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "recall-1861-"));
  const db = initializeDatabase(join(dir, "memory.db"));
  const deps: RecallDeps = { db, index: new MemoryIndex(db), memoryDir: dir };
  if (embedding) {
    deps.embeddingProvider = {
      name: "scripted", dimensions: embedding.length,
      embedText: async () => embedding,
      batchEmbed: async () => [],
    };
  }
  return { db, deps, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

let nextId = 1;

function seedRow(f: Fixture, opts: {
  content: string; userId?: string; createdAt?: number; classification?: number;
  embedding?: number[]; signature?: Buffer;
}): number {
  const id = nextId++;
  const created = opts.createdAt ?? Date.now();
  f.db.prepare(
    `INSERT INTO extracted_memories
       (id, user_id, content_en, content_original, memory_type, source_timestamp, created_at,
        classification, emotion_score, confidence, embedding, signature)
     VALUES (?, ?, ?, ?, 'fact', ?, ?, ?, 0, 3, ?, ?)`,
  ).run(
    id, opts.userId ?? USER, opts.content, opts.content, created, created,
    opts.classification ?? 1,
    opts.embedding ? vec(opts.embedding) : null,
    opts.signature ?? null,
  );
  return id;
}

function resultIds(result: { results: Array<{ id?: number }> }): Array<number | undefined> {
  return result.results.map((hit) => hit.id);
}

// ── Sf coverage ordering ────────────────────────────────────────────────────

describe("#1861 hasTokenBoundaryMatch", () => {
  it("accepts token starts and inflections, rejects mid-token collisions", () => {
    expect(hasTokenBoundaryMatch("A dog barks", "dog")).toBe(true);
    expect(hasTokenBoundaryMatch("dogs and doghouses", "dog")).toBe(true);
    expect(hasTokenBoundaryMatch("The watchdog guards", "dog")).toBe(false);
    expect(hasTokenBoundaryMatch("rókára emlékszem", "roka")).toBe(true);
    expect(hasTokenBoundaryMatch("anything", "")).toBe(false);
  });
});

describe("#1861 Sf coverage ordering", () => {
  it("ranks a token-boundary match above a stemming-only collision", async () => {
    const f = makeFixture();
    try {
      const collision = seedRow(f, { content: "She felt happy" });
      const topical = seedRow(f, { content: "Happiness grows in the garden" });
      const res = await recallSearch(f.deps, { translated: ["happiness"], userId: USER, limit: 10 });
      const pool = (res.stages["Sf"]?.hits ?? []).map((hit) => hit.id);
      expect(pool).toContain(collision);
      expect(pool).toContain(topical);
      expect(pool.indexOf(topical)).toBeLessThan(pool.indexOf(collision));
    } finally { f.close(); }
  });

  it("ranks a topical match above a mid-token substring distractor", async () => {
    const f = makeFixture();
    try {
      const topical = seedRow(f, { content: "Dog care basics" });
      const substring = seedRow(f, { content: "The watchdog guards the yard" });
      const res = await recallSearch(f.deps, { translated: ["dog"], userId: USER, limit: 10 });
      const pool = (res.stages["Sf"]?.hits ?? []).map((hit) => hit.id);
      expect(pool).toContain(topical);
      expect(pool).toContain(substring);
      expect(pool.indexOf(topical)).toBeLessThan(pool.indexOf(substring));
    } finally { f.close(); }
  });
});

// ── Full-history Se ─────────────────────────────────────────────────────────

describe("#1861 full-history Se", () => {
  it("reaches an eligible target behind 500+ newer rows (exact and paraphrase)", async () => {
    const f = makeFixture(Q);
    try {
      const targetId = seedRow(f, {
        content: "The tester-architect paradox",
        createdAt: Date.now() - 700 * DAY,
        embedding: [1, 0, 0],
      });
      const distractorId = seedRow(f, {
        content: "tester tools that resemble architecture notes",
        createdAt: Date.now() - 400 * DAY,
        embedding: [0, 1, 0],
      });
      for (let i = 0; i < 520; i++) {
        seedRow(f, { content: `archive note ${i}`, createdAt: Date.now() - i * 60000, embedding: [0, 1, 0] });
      }

      const exact = await recallSearch(f.deps, {
        translated: ["tester", "architect", "paradox"], userId: USER, limit: 10, trackRecalls: false,
      });
      const ids = resultIds(exact);
      expect(ids).toContain(targetId);
      expect(ids.indexOf(targetId)).toBeLessThan(ids.indexOf(distractorId));
      expect(exact.stageOutcomes?.["Se"]?.status).toBe("completed");
      expect(exact.stageOutcomes?.["Se"]?.hitCount).toBeGreaterThanOrEqual(1);

      const paraphrase = await recallSearch(f.deps, {
        translated: ["midnight", "perfectionist"], userId: USER, limit: 10, trackRecalls: false,
      });
      expect(resultIds(paraphrase)).toContain(targetId);
      expect(paraphrase.weakEvidence).toBe(false);
    } finally { f.close(); }
  });

  it("does not leak or crowd out an eligible target behind similar inaccessible rows", async () => {
    const f = makeFixture(Q);
    try {
      for (let i = 0; i < 30; i++) {
        seedRow(f, {
          userId: FOREIGN, classification: 2, content: `foreign private ${i}`,
          createdAt: Date.now() - i * 60000, embedding: [1, 0, 0],
        });
      }
      const targetId = seedRow(f, {
        content: "eligible older needle",
        createdAt: Date.now() - 700 * DAY,
        embedding: [0.98, 0.19, 0],
      });
      const res = await recallSearch(f.deps, { translated: ["needle"], userId: USER, limit: 3, trackRecalls: false });
      expect(resultIds(res)).toContain(targetId);
      expect(res.results.some((hit) => hit.content.includes("foreign private"))).toBe(false);
      expect(res.stageOutcomes?.["Se"]?.hitCount).toBe(1);
    } finally { f.close(); }
  });
});

// ── Full-history Ss ─────────────────────────────────────────────────────────

describe("#1861 full-history Ss", () => {
  it("considers eligible signed rows older than 500 newer records", async () => {
    const f = makeFixture();
    try {
      const targetId = seedRow(f, {
        content: "quantum entanglement coherence",
        createdAt: Date.now() - 700 * DAY,
        signature: Buffer.from(generateSignature("quantum entanglement coherence")),
      });
      for (let i = 0; i < 520; i++) {
        seedRow(f, {
          content: `archive note ${i}`,
          createdAt: Date.now() - i * 60000,
          signature: Buffer.from(generateSignature(`archive note ${i}`)),
        });
      }
      const res = await recallSearch(f.deps, {
        translated: ["quantum", "entanglement", "coherence"],
        userId: USER, limit: 10, stages: ["Ss"], trackRecalls: false,
      });
      expect(res.stageOutcomes?.["Ss"]?.status).toBe("completed");
      expect(resultIds(res)).toContain(targetId);
    } finally { f.close(); }
  });
});

// ── vec_memories index path (when sqlite-vec is installed) ──────────────────

describe.skipIf(!nativeVecAvailable())("#1861 vec index path", () => {
  function seedIndexRows(f: Fixture): void {
    initVec(f.db, 3);
    const rows = f.db.prepare("SELECT id, embedding FROM extracted_memories WHERE embedding IS NOT NULL").all() as Array<{ id: number; embedding: Buffer }>;
    for (const row of rows) {
      f.db.prepare(`INSERT INTO vec_memories (rowid, embedding) VALUES (${row.id}, ?)`).run(row.embedding);
    }
  }

  it("finds the eligible target through a complete index", async () => {
    const f = makeFixture(Q);
    try {
      const targetId = seedRow(f, {
        content: "eligible vector target",
        createdAt: Date.now() - 700 * DAY,
        embedding: [1, 0, 0],
      });
      for (let i = 0; i < 20; i++) seedRow(f, { content: `archive ${i}`, embedding: [0, 1, 0] });
      seedIndexRows(f);
      expect(vecAvailable()).toBe(true);
      const res = await recallSearch(f.deps, { translated: ["vector"], userId: USER, limit: 3, trackRecalls: false });
      expect(resultIds(res)).toContain(targetId);
    } finally { f.close(); }
  });

  it("falls back to the full scan when the window is crowded by inaccessible rows", async () => {
    const f = makeFixture(Q);
    try {
      for (let i = 0; i < 300; i++) {
        seedRow(f, {
          userId: FOREIGN, classification: 2, content: `foreign private ${i}`,
          createdAt: Date.now() - i * 60000, embedding: [1, 0, 0],
        });
      }
      const targetId = seedRow(f, {
        content: "eligible older needle",
        createdAt: Date.now() - 700 * DAY,
        embedding: [0.98, 0.19, 0],
      });
      seedIndexRows(f);
      const res = await recallSearch(f.deps, { translated: ["needle"], userId: USER, limit: 3, trackRecalls: false });
      expect(resultIds(res)).toContain(targetId);
      expect(res.results.some((hit) => hit.content.includes("foreign private"))).toBe(false);
      expect(res.stageOutcomes?.["Se"]?.hitCount).toBe(1);
    } finally { f.close(); }
  });

  it("falls back when a stale index row masks a missing embedded memory", async () => {
    const f = makeFixture(Q);
    try {
      const targetId = seedRow(f, {
        content: "eligible vector target",
        embedding: [1, 0, 0],
      });
      seedRow(f, { content: "orthogonal archive", embedding: [0, 1, 0] });
      initVec(f.db, 3);
      const rows = f.db.prepare(
        "SELECT id, embedding FROM extracted_memories WHERE embedding IS NOT NULL",
      ).all() as Array<{ id: number; embedding: Buffer }>;
      for (const row of rows) {
        if (row.id === targetId) continue;
        f.db.prepare(`INSERT INTO vec_memories (rowid, embedding) VALUES (${row.id}, ?)`).run(row.embedding);
      }
      // Keep the index count equal to the embedded row count while replacing
      // the target's vector with an orphaned row. Count-only checks miss this.
      f.db.prepare("INSERT INTO vec_memories (rowid, embedding) VALUES (999999, ?)")
        .run(vec([1, 0, 0]));

      const result = await recallSearch(f.deps, {
        translated: ["target"], userId: USER, limit: 3, trackRecalls: false,
      });
      expect(resultIds(result)).toContain(targetId);
    } finally { f.close(); }
  });
});
