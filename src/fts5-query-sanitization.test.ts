import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import Database from "better-sqlite3";
import { MemoryIndex } from "./memory-index.js";

/**
 * Bug Condition Exploration Test — FTS5 Query Sanitization
 *
 * These tests are EXPECTED TO FAIL on unfixed code.
 * Failure confirms the bug exists: MemoryIndex.search passes raw queries
 * to FTS5 MATCH without sanitization, causing SqliteError on special chars.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5
 */

const fts5SpecialChars = ['"', ",", "(", ")", "*", "^", "+", "-", ":", "{", "}"];
const fts5Operators = ["AND", "OR", "NOT", "NEAR"];

function isBugCondition(query: string): boolean {
  if (!query.trim()) return false;
  const hasSpecialChar = fts5SpecialChars.some((ch) => query.includes(ch));
  const words = query.split(/\s+/);
  const hasOperator = words.some((w) => fts5Operators.includes(w.toUpperCase()));
  return hasSpecialChar || hasOperator;
}

describe("FTS5 Bug Condition Exploration", () => {
  let db: Database.Database;
  let index: MemoryIndex;

  beforeAll(() => {
    db = new Database(":memory:");

    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL DEFAULT 'aksika',
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        platform_message_id INTEGER,
        emotion_score INTEGER DEFAULT 0,
        type_hint TEXT,
        topic_hint TEXT,
        emotion_hint TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content=messages, content_rowid=id);
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);

    index = new MemoryIndex(db);

    // Seed sample messages
    const samples = [
      { role: "user" as const, content: "hello world how are you", timestamp: 1000, userId: "aksika", sessionId: "s1" },
      { role: "assistant" as const, content: "I am doing well thank you", timestamp: 2000, userId: "aksika", sessionId: "s1" },
      { role: "user" as const, content: "quantum computing is fascinating", timestamp: 3000, userId: "aksika", sessionId: "s1" },
      { role: "assistant" as const, content: "the price of goods varies by quantity", timestamp: 4000, userId: "user-2", sessionId: "s2" },
      { role: "user" as const, content: "not bad for a first attempt", timestamp: 5000, userId: "user-2", sessionId: "s2" },
    ];

    for (const msg of samples) {
      index.index(msg);
    }
  });

  afterAll(() => {
    db.close();
  });

  /**
   * Property 1: Fault Condition — FTS5 Special Characters Do Not Crash Search
   *
   * For all inputs where isBugCondition(input) holds, calling search(query)
   * SHALL NOT throw and SHALL return an array.
   *
   * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5**
   */
  it("property: search does not throw for queries with FTS5 special characters", () => {
    const queryArb = fc
      .string({
        unit: fc.constantFrom(...fts5SpecialChars, ..."abcdefghijklmnopqrstuvwxyz ".split("")),
        minLength: 1,
        maxLength: 60,
      })
      .filter((s) => isBugCondition(s));

    fc.assert(
      fc.property(queryArb, (query) => {
        const results = index.search(query);
        expect(results).toBeInstanceOf(Array);
        for (const r of results) {
          expect(r).toHaveProperty("record");
          expect(r).toHaveProperty("score");
          expect(r.score).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  // Deterministic cases — each targets a specific FTS5 special character category
  it("deterministic: comma — search('hello, world') does not throw", () => {
    const results = index.search("hello, world");
    expect(results).toBeInstanceOf(Array);
  });

  it("deterministic: unbalanced quote — search('he said \"hello') does not throw", () => {
    const results = index.search('he said "hello');
    expect(results).toBeInstanceOf(Array);
  });

  it("deterministic: operator keyword — search('NOT bad') does not throw", () => {
    const results = index.search("NOT bad");
    expect(results).toBeInstanceOf(Array);
  });

  it("deterministic: parentheses — search('function(arg)') does not throw", () => {
    const results = index.search("function(arg)");
    expect(results).toBeInstanceOf(Array);
  });

  it("deterministic: asterisk — search('price * quantity') does not throw", () => {
    const results = index.search("price * quantity");
    expect(results).toBeInstanceOf(Array);
  });

  it("deterministic: caret — search('test^2') does not throw", () => {
    const results = index.search("test^2");
    expect(results).toBeInstanceOf(Array);
  });
});


/**
 * Preservation Tests — FTS5 Query Sanitization
 *
 * These tests capture baseline behavior on UNFIXED code for plain queries
 * (no FTS5 special characters). They MUST PASS on unfixed code, confirming
 * the behavior we need to preserve after the fix is applied.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4
 */
describe("FTS5 Preservation Tests", () => {
  let db: Database.Database;
  let index: MemoryIndex;

  beforeAll(() => {
    db = new Database(":memory:");

    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL DEFAULT 'aksika',
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        platform_message_id INTEGER,
        emotion_score INTEGER DEFAULT 0,
        type_hint TEXT,
        topic_hint TEXT,
        emotion_hint TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content=messages, content_rowid=id);
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);

    index = new MemoryIndex(db);

    // Seed known messages for deterministic assertions
    const samples = [
      { role: "user" as const, content: "hello world how are you", timestamp: 1000, userId: "aksika", sessionId: "s1" },
      { role: "assistant" as const, content: "I am doing well thank you", timestamp: 2000, userId: "aksika", sessionId: "s1" },
      { role: "user" as const, content: "quantum computing is fascinating", timestamp: 3000, userId: "aksika", sessionId: "s1" },
      { role: "assistant" as const, content: "the price of goods varies by quantity", timestamp: 4000, userId: "user-2", sessionId: "s2" },
      { role: "user" as const, content: "not bad for a first attempt", timestamp: 5000, userId: "user-2", sessionId: "s2" },
      { role: "user" as const, content: "hello again from the other side", timestamp: 6000, userId: "aksika", sessionId: "s1" },
      { role: "assistant" as const, content: "world peace is a noble goal", timestamp: 7000, userId: "user-2", sessionId: "s2" },
    ];

    for (const msg of samples) {
      index.index(msg);
    }
  });

  afterAll(() => {
    db.close();
  });

  /**
   * Property 2: Preservation — Plain Query Behavior Unchanged
   *
   * For all queries containing only plain alphanumeric characters and spaces,
   * search returns an array without throwing and results have valid record/score fields.
   *
   * **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
   */
  it("property: plain alphanumeric queries return valid results without throwing", () => {
    const plainQueryArb = fc.string({
      unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789 ".split("")),
      minLength: 1,
      maxLength: 40,
    });

    fc.assert(
      fc.property(plainQueryArb, (query) => {
        const results = index.search(query);
        expect(results).toBeInstanceOf(Array);
        for (const r of results) {
          expect(r).toHaveProperty("record");
          expect(r).toHaveProperty("score");
          expect(r.record).toHaveProperty("role");
          expect(r.record).toHaveProperty("content");
          expect(r.record).toHaveProperty("timestamp");
          expect(r.record).toHaveProperty("userId");
          expect(r.record).toHaveProperty("sessionId");
          expect(r.score).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  // --- Deterministic preservation tests ---

  it("search('hello world') returns BM25-ranked results matching those words", () => {
    const results = index.search("hello world");
    expect(results).toBeInstanceOf(Array);
    expect(results.length).toBeGreaterThan(0);

    // All results should contain "hello" or "world"
    for (const r of results) {
      const content = r.record.content.toLowerCase();
      expect(content.includes("hello") || content.includes("world")).toBe(true);
    }

    // Scores should be non-negative and ordered by relevance (descending score)
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1];
      const cur = results[i];
      if (prev === undefined || cur === undefined) throw new Error("unexpected missing result");
      expect(prev.score).toBeGreaterThanOrEqual(cur.score);
    }
  });

  it("search('') returns empty array", () => {
    const results = index.search("");
    expect(results).toEqual([]);
  });

  it("search('   ') returns empty array", () => {
    const results = index.search("   ");
    expect(results).toEqual([]);
  });

  it("search('quantum') returns matching single-word results", () => {
    const results = index.search("quantum");
    expect(results).toBeInstanceOf(Array);
    expect(results.length).toBeGreaterThan(0);

    for (const r of results) {
      expect(r.record.content.toLowerCase()).toContain("quantum");
    }
  });

  it("search with userId filter applies correctly", () => {
    const results = index.search("hello", { userId: "aksika" });
    expect(results).toBeInstanceOf(Array);
    expect(results.length).toBeGreaterThan(0);

    for (const r of results) {
      expect(r.record.userId).toBe("aksika");
    }
  });

  it("search with non-existent userId returns empty", () => {
    const results = index.search("hello", { userId: "nonexistent" });
    expect(results).toEqual([]);
  });

  it("search with startTime filter returns only messages at or after that time", () => {
    const results = index.search("hello", { startTime: 5000 });
    expect(results).toBeInstanceOf(Array);

    for (const r of results) {
      expect(r.record.timestamp).toBeGreaterThanOrEqual(5000);
    }
  });

  it("search with endTime filter returns only messages at or before that time", () => {
    const results = index.search("hello", { endTime: 2000 });
    expect(results).toBeInstanceOf(Array);

    for (const r of results) {
      expect(r.record.timestamp).toBeLessThanOrEqual(2000);
    }
  });

  it("search with limit option caps the number of results", () => {
    const results = index.search("hello", { limit: 1 });
    expect(results).toBeInstanceOf(Array);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("BM25 ranking: scores are non-negative and ordered by relevance", () => {
    const results = index.search("hello world");
    expect(results.length).toBeGreaterThan(0);

    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
    }

    // Results should be ordered by score descending (most relevant first)
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1];
      const cur = results[i];
      if (prev === undefined || cur === undefined) throw new Error("unexpected missing result");
      expect(prev.score).toBeGreaterThanOrEqual(cur.score);
    }
  });
});
