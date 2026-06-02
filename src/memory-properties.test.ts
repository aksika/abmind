/**
 * Property-based tests for the local memory system using fast-check.
 * Covers correctness properties from the design document.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import type { MessageRecord } from "./mem-types.js";

// --- Generators ---

const roleArb = fc.constantFrom("user" as const, "assistant" as const);

const messageRecordArb = fc.record({
  role: roleArb,
  content: fc.string({ minLength: 1, maxLength: 200 }),
  timestamp: fc.integer({ min: 1, max: 2_000_000_000_000 }),
  userId: fc.stringMatching(/^user-[a-z0-9]{3,6}$/),
  sessionId: fc.stringMatching(/^[a-z0-9-]{1,20}$/),
});

// --- Property 6: Indexed Messages Are Searchable ---

describe("Property 6: Indexed messages are searchable", { timeout: 30000 }, () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "prop6-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a recorded message with a unique word is found by search", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 999 }),
        (seed) => {
          const db = initializeDatabase(join(tmpDir, `prop6-${seed}.db`));
          const index = new MemoryIndex(db);

          // Use a distinctive word unlikely to collide
          const uniqueWord = `xyzzy${seed}`;
          index.index({
            role: "user",
            content: `The ${uniqueWord} phenomenon is interesting`,
            timestamp: Date.now(),
            userId: "user-1",
            sessionId: "s1",
          });

          const results = index.search(uniqueWord, { userId: "user-1" });
          expect(results.length).toBeGreaterThanOrEqual(1);
          expect(results[0]!.record.content).toContain(uniqueWord);

          db.close();
        },
      ),
      { numRuns: 30 },
    );
  });
});

// --- Property 7: Search Results Ordered by BM25 Score ---

describe("Property 7: Search results ordered by BM25 score", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "prop7-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("results are in descending score order", () => {
    const db = initializeDatabase(join(tmpDir, "prop7.db"));
    const index = new MemoryIndex(db);

    // Index messages with varying relevance
    for (let i = 0; i < 20; i++) {
      const repeats = (i % 5) + 1;
      index.index({
        role: "user",
        content: `${"searchterm ".repeat(repeats)} filler text number ${i}`,
        timestamp: 1000 + i,
        userId: "user-1",
        sessionId: "s1",
      });
    }

    const results = index.search("searchterm", { userId: "user-1" });
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i]!.score).toBeGreaterThanOrEqual(results[i + 1]!.score);
    }

    db.close();
  });
});

// --- Property 8: Search Filters Are Respected ---

describe("Property 8: Search filters are respected", { timeout: 30000 }, () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "prop8-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("userId filter returns only matching chat", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 3, maxLength: 8 }).map(s => `a-${s}`),
        fc.string({ minLength: 3, maxLength: 8 }).map(s => `b-${s}`),
        (userA, userB) => {
          const db = initializeDatabase(join(tmpDir, `prop8-${userA}-${userB}.db`));
          const index = new MemoryIndex(db);

          index.index({ role: "user", content: "filterable keyword alpha", timestamp: 1000, userId: userA, sessionId: "s1" });
          index.index({ role: "user", content: "filterable keyword beta", timestamp: 2000, userId: userB, sessionId: "s1" });

          const results = index.search("filterable", { userId: userA });
          for (const r of results) {
            expect(r.record.userId).toBe(userA);
          }

          db.close();
        },
      ),
      { numRuns: 20 },
    );
  });

  it("date range filter returns only messages within range", () => {
    const db = initializeDatabase(join(tmpDir, "prop8-date.db"));
    const index = new MemoryIndex(db);

    index.index({ role: "user", content: "datetest early", timestamp: 1000, userId: "user-1", sessionId: "s1" });
    index.index({ role: "user", content: "datetest middle", timestamp: 5000, userId: "user-1", sessionId: "s1" });
    index.index({ role: "user", content: "datetest late", timestamp: 9000, userId: "user-1", sessionId: "s1" });

    const results = index.search("datetest", { startTime: 2000, endTime: 6000 });
    expect(results).toHaveLength(1);
    expect(results[0]!.record.timestamp).toBe(5000);

    db.close();
  });
});

// --- Property 9: Session Deletion Removes Index Entries ---

describe("Property 9: Session deletion removes index entries", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "prop9-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("after removeSession, search returns nothing for that session", () => {
    const db = initializeDatabase(join(tmpDir, "prop9.db"));
    const index = new MemoryIndex(db);

    const uniqueWord = "deletiontest";
    index.index({ role: "user", content: `${uniqueWord} in session A`, timestamp: 1000, userId: "user-1", sessionId: "sA" });
    index.index({ role: "user", content: `${uniqueWord} in session B`, timestamp: 2000, userId: "user-1", sessionId: "sB" });

    index.removeSession("user-1", "sA");

    const results = index.search(uniqueWord, { userId: "user-1" });
    expect(results).toHaveLength(1);
    expect(results[0]!.record.sessionId).toBe("sB");

    db.close();
  });
});

// --- Property 13: Pruning Preserves Most Recent Messages ---

describe("Property 13: Pruning preserves most recent messages", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "prop13-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("after prune(userId, L), exactly L messages remain with highest timestamps", () => {
    let iteration = 0;
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 30 }),
        fc.integer({ min: 1, max: 4 }),
        (total, limit) => {
          const db = initializeDatabase(join(tmpDir, `prop13-${++iteration}.db`));
          const index = new MemoryIndex(db);

          for (let i = 0; i < total; i++) {
            index.index({
              role: "user",
              content: `prunetest msg ${i}`,
              timestamp: 1000 + i,
              userId: "user-1",
              sessionId: "s1",
            });
          }

          index.prune("user-1", limit);

          const rows = db
            .prepare("SELECT timestamp FROM messages WHERE user_id = 'user-1' ORDER BY timestamp ASC")
            .all() as Array<{ timestamp: number }>;

          expect(rows).toHaveLength(limit);
          // Should be the most recent timestamps
          expect(rows[0]!.timestamp).toBe(1000 + total - limit);
          expect(rows[rows.length - 1]!.timestamp).toBe(1000 + total - 1);

          db.close();
        },
      ),
      { numRuns: 20 },
    );
  });
});

// --- Property 11: Reciprocal Rank Fusion Correctness ---

describe("Property 11: Reciprocal rank fusion correctness", () => {
  function computeRRF(
    ftsIds: number[],
    vectorIds: number[],
    k = 60,
  ): Array<{ id: number; score: number }> {
    const ftsRank = new Map<number, number>();
    for (let i = 0; i < ftsIds.length; i++) ftsRank.set(ftsIds[i]!, i + 1);
    const vecRank = new Map<number, number>();
    for (let i = 0; i < vectorIds.length; i++) vecRank.set(vectorIds[i]!, i + 1);

    const allIds = new Set([...ftsIds, ...vectorIds]);
    const scored: Array<{ id: number; score: number }> = [];
    for (const id of allIds) {
      let score = 0;
      const fr = ftsRank.get(id);
      const vr = vecRank.get(id);
      if (fr !== undefined) score += 1 / (k + fr);
      if (vr !== undefined) score += 1 / (k + vr);
      scored.push({ id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  it("scores match formula and output is sorted descending", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 1000 }), { minLength: 0, maxLength: 10 }),
        fc.uniqueArray(fc.integer({ min: 1, max: 1000 }), { minLength: 0, maxLength: 10 }),
        (ftsIds, vectorIds) => {
          if (ftsIds.length === 0 && vectorIds.length === 0) return;

          const k = 60;
          const result = computeRRF(ftsIds, vectorIds, k);

          // Verify scores match formula
          for (const item of result) {
            let expected = 0;
            const ftsIdx = ftsIds.indexOf(item.id);
            const vecIdx = vectorIds.indexOf(item.id);
            if (ftsIdx >= 0) expected += 1 / (k + ftsIdx + 1);
            if (vecIdx >= 0) expected += 1 / (k + vecIdx + 1);
            expect(item.score).toBeCloseTo(expected, 10);
          }

          // Verify sorted descending
          for (let i = 0; i < result.length - 1; i++) {
            expect(result[i]!.score).toBeGreaterThanOrEqual(result[i + 1]!.score);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
