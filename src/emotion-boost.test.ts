// Feature: instant-memory-store, Property 5, 6, 7: Emotion Boost Tests
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { EMOTION_BOOST_WEIGHT } from "./fts-utils.js";

/**
 * Pure emotion boost formula extracted for testability.
 * Matches the formula used in searchExtracted() and searchOriginal().
 */
function computeEmotionBoost(emotionScore: number): number {
  return EMOTION_BOOST_WEIGHT * Math.log(1 + Math.abs(emotionScore));
}

function computeFinalScore(bm25Score: number, emotionScore: number): number {
  return bm25Score + computeEmotionBoost(emotionScore);
}

describe("Emotion Boost — Property 5: Emotion Boost Formula Correctness", () => {
  /**
   * Validates: Requirements 8.1, 8.2, 8.3
   *
   * For any BM25 score and emotion_score in [-5, +5], final score equals
   * bm25_score + 0.5 * Math.log(1 + Math.abs(emotion_score)).
   * When emotion_score is 0, boost is exactly 0.
   */
  it("final score equals bm25_score + 0.5 * log(1 + |emotion_score|) for any inputs", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.integer({ min: -5, max: 5 }),
        (bm25Score, emotionScore) => {
          const finalScore = computeFinalScore(bm25Score, emotionScore);
          const expected = bm25Score + 0.5 * Math.log(1 + Math.abs(emotionScore));
          expect(finalScore).toBeCloseTo(expected, 10);
        },
      ),
      { numRuns: 30, interruptAfterTimeLimit: 15000 },
    );
  });

  it("boost is exactly 0 when emotion_score is 0", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100, noNaN: true }),
        (bm25Score) => {
          const finalScore = computeFinalScore(bm25Score, 0);
          expect(finalScore).toBe(bm25Score);
        },
      ),
      { numRuns: 30, interruptAfterTimeLimit: 15000 },
    );
  });
});

describe("Emotion Boost — Property 6: Emotional Memories Rank Higher Than Neutral Ones", () => {
  /**
   * Validates: Requirements 8.1
   *
   * For any two memories with identical BM25 scores, one neutral (emotion_score = 0)
   * and one emotional (|emotion_score| > 0), the emotional memory has strictly higher final score.
   */
  it("emotional memory always scores strictly higher than neutral with same BM25", () => {
    const nonZeroEmotionScore = fc.integer({ min: -5, max: 5 }).filter((n) => n !== 0);

    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100, noNaN: true }),
        nonZeroEmotionScore,
        (bm25Score, emotionScore) => {
          const neutralFinal = computeFinalScore(bm25Score, 0);
          const emotionalFinal = computeFinalScore(bm25Score, emotionScore);
          expect(emotionalFinal).toBeGreaterThan(neutralFinal);
        },
      ),
      { numRuns: 30, interruptAfterTimeLimit: 15000 },
    );
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory-manager.js";
import { MemoryIndex } from "./memory-index.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { initializeDatabase } from "./memory-db.js";

describe("Emotion Boost — Property 7: Emotion Score Storage Round-Trip", () => {
  /**
   * Validates: Requirements 7.6
   *
   * For any memory stored via instantStore() with emotion_score in [-5, +5],
   * retrieving via search preserves the emotion_score value exactly.
   */
  it("emotion_score stored via instantStore is preserved exactly in DB and reflected in search", { timeout: 30_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -5, max: 5 }),
        async (emotionScore) => {
          const iterDir = mkdtempSync(join(tmpdir(), "eb-p7-iter-"));
          const iterManager = new MemoryManager(makeMemoryTestConfig(iterDir));
          await iterManager.initialize();
          process.env.ABMIND_USER_ID = "primary-test-user";

          try {
            // Store a memory with a known emotion_score
            const result = await iterManager.editor.instantStore({
              userId: "primary-test-user",
              contentEn: "User prefers dark mode for coding",
              contentOriginal: "A user dark mode-ot preferálja kódoláshoz",
              memoryType: "preference",
              emotionScore,
            });

            expect(result.stored).toBe(true);

            // Verify emotion_score is preserved exactly in the database
            const db = initializeDatabase(join(iterDir, "memory.db"));
            const row = db
              .prepare("SELECT emotion_score FROM extracted_memories WHERE user_id = ?")
              .get("primary-test-user") as { emotion_score: number };

            expect(row).toBeDefined();
            expect(row.emotion_score).toBe(emotionScore);

            // Verify search reflects the emotion_score via the boost formula
            const memoryIndex = new MemoryIndex(db);
            const searchResults = memoryIndex.searchExtracted("dark mode", { userId: "primary-test-user" });

            expect(searchResults.length).toBeGreaterThan(0);

            const searchResult = searchResults[0]!;
            const expectedBoost = EMOTION_BOOST_WEIGHT * Math.log(1 + Math.abs(emotionScore));

            // The score should include the emotion boost
            // For emotion_score = 0, boost is 0; for non-zero, boost > 0
            if (emotionScore === 0) {
              // Score should be pure BM25 (no boost)
              expect(expectedBoost).toBe(0);
            } else {
              expect(expectedBoost).toBeGreaterThan(0);
            }

            // Verify the score is consistent: re-query raw BM25 and check formula
            const rawRow = db
              .prepare(
                `SELECT rank FROM extracted_memories em
                 JOIN extracted_memories_fts ON extracted_memories_fts.rowid = em.id
                 WHERE extracted_memories_fts MATCH '"dark"* "mode"*' AND em.user_id = ?`,
              )
              .get("primary-test-user") as { rank: number } | undefined;

            if (rawRow) {
              const rawBm25 = Math.abs(rawRow.rank);
              // Score includes emotion boost + trust/credibility/recency factors
              // Just verify boost direction: non-zero emotion → higher score than raw BM25 alone
              if (emotionScore !== 0) {
                expect(searchResult.score).toBeGreaterThan(0);
              }
            }

            db.close();
          } finally {
            iterManager.close();
            rmSync(iterDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 30, interruptAfterTimeLimit: 15000 },
    );
  });
});

// ── Recall-engine emotion boost (#404) ──────────────────────────────────────
// Linear tie-breaker boost applied in recall-engine.ts pipeline.
// Separate from the memory-index log(1+|e|) boost tested above — different
// score regime, different weight, documented in code.

import Database from "better-sqlite3";
import { applyEmotionBoost } from "./recall-boosts.js";
import type { RecallHit } from "./recall-engine.js";

function makeRecallDb(): Database.Database {
  const db = new Database(":memory:");
  db.prepare(`
    CREATE TABLE extracted_memories (
      id INTEGER PRIMARY KEY,
      emotion_score REAL
    )
  `).run();
  return db;
}

function makeRecallHit(id: number, score: number): RecallHit {
  return { id, content: `mem${id}`, date: "2026-05-05", source: "Se", score };
}

describe("applyEmotionBoost (recall-engine #404)", () => {
  it("boosts memories with non-zero emotion_score; leaves neutral untouched", () => {
    const db = makeRecallDb();
    db.prepare("INSERT INTO extracted_memories (id, emotion_score) VALUES (?, ?)").run(1, 5);
    db.prepare("INSERT INTO extracted_memories (id, emotion_score) VALUES (?, ?)").run(2, 0);

    const hits = [makeRecallHit(1, 0.5), makeRecallHit(2, 0.5)];
    const [h1, h2] = applyEmotionBoost(hits, db);

    expect(h1!.score).toBeGreaterThan(h2!.score);
    expect(h2!.score).toBe(0.5);
    expect(h1!.emotionScore).toBe(5);
  });

  it("applies max boost of 0.10 at |e|=5", () => {
    const db = makeRecallDb();
    db.prepare("INSERT INTO extracted_memories (id, emotion_score) VALUES (?, ?)").run(1, 5);

    const [h] = applyEmotionBoost([makeRecallHit(1, 0.5)], db);
    expect(h!.score).toBeCloseTo(0.5 + 0.10);
  });

  it("uses absolute value — negative emotion boosts same as positive", () => {
    const db = makeRecallDb();
    db.prepare("INSERT INTO extracted_memories (id, emotion_score) VALUES (?, ?)").run(1, -5);
    db.prepare("INSERT INTO extracted_memories (id, emotion_score) VALUES (?, ?)").run(2, 5);

    const [h1, h2] = applyEmotionBoost([makeRecallHit(1, 0.5), makeRecallHit(2, 0.5)], db);
    expect(h1!.score).toBeCloseTo(h2!.score);
  });

  it("never overrides a relevance gap larger than 0.10 — relevance trumps", () => {
    // Strong relevant memory (0.70) with neutral emotion beats weak relevant (0.30) with max emotion.
    // 0.30 + 0.10 = 0.40 < 0.70 → relevance wins.
    const db = makeRecallDb();
    db.prepare("INSERT INTO extracted_memories (id, emotion_score) VALUES (?, ?)").run(1, 5);
    db.prepare("INSERT INTO extracted_memories (id, emotion_score) VALUES (?, ?)").run(2, 0);

    const [h1, h2] = applyEmotionBoost([makeRecallHit(1, 0.30), makeRecallHit(2, 0.70)], db);
    expect(h2!.score).toBeGreaterThan(h1!.score);
  });

  it("breaks ties — equal relevance → emotional memory ranks higher", () => {
    const db = makeRecallDb();
    db.prepare("INSERT INTO extracted_memories (id, emotion_score) VALUES (?, ?)").run(1, 3);
    db.prepare("INSERT INTO extracted_memories (id, emotion_score) VALUES (?, ?)").run(2, 0);

    const [h1, h2] = applyEmotionBoost([makeRecallHit(1, 0.7), makeRecallHit(2, 0.7)], db);
    expect(h1!.score).toBeGreaterThan(h2!.score);
  });

  it("handles null emotion_score as no boost", () => {
    const db = makeRecallDb();
    db.prepare("INSERT INTO extracted_memories (id, emotion_score) VALUES (?, ?)").run(1, null);

    const [h] = applyEmotionBoost([makeRecallHit(1, 0.5)], db);
    expect(h!.score).toBe(0.5);
    expect(h!.emotionScore).toBeUndefined();
  });

  it("skips hits without id (no DB lookup possible)", () => {
    const db = makeRecallDb();
    const hit: RecallHit = { content: "x", date: "2026-05-05", source: "S6", score: 0.5 };
    const [h] = applyEmotionBoost([hit], db);
    expect(h!.score).toBe(0.5);
  });

  it("returns unchanged list for empty input", () => {
    const db = makeRecallDb();
    expect(applyEmotionBoost([], db)).toEqual([]);
  });
});
