// Feature: instant-memory-store, Property 2: Instant Store Persists Valid Memories
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager, getMemoryDb } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import type { InstantStoreParams } from "./mem-types.js";
import { initializeDatabase } from "./memory-db.js";

const validMemoryType = fc.oneof(
  fc.constant("fact" as const),
  fc.constant("decision" as const),
  fc.constant("preference" as const),
  fc.constant("event" as const),
  fc.constant("lesson" as const),
  fc.constant("feedback" as const),
    fc.constant("story" as const),
);

/** Generate a non-empty string (at least 1 printable char). */
const nonEmptyString = fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0);

const validInstantStoreParams: fc.Arbitrary<InstantStoreParams> = fc.record({
  userId: fc.integer({ min: 1, max: 999999 }),
  contentEn: nonEmptyString,
  contentOriginal: nonEmptyString,
  memoryType: validMemoryType,
  emotionScore: fc.integer({ min: -5, max: 5 }),
  keyword: fc.option(nonEmptyString, { nil: undefined }),
});

describe("instantStore — Property 2: Instant Store Persists Valid Memories", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "is-prop2-"));
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Validates: Requirements 3.1, 3.2, 3.3, 3.4
   *
   * For any valid InstantStoreParams, instantStore() inserts exactly one row
   * with preserve_original = true and all fields matching input.
   */
  it("persists exactly one row with correct fields for any valid params", { timeout: 30_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(validInstantStoreParams, async (params) => {
        // Re-create DB for each iteration to ensure isolation
        const iterDir = mkdtempSync(join(tmpdir(), "is-p2-iter-"));
        const iterManager = new MemoryManager(makeMemoryTestConfig(iterDir));
        await iterManager.initialize();

        try {
          const result = await iterManager.editor.instantStore(params);

          expect(result.stored).toBe(true);
          expect(result.memoriesCount).toBe(1);
          expect(result.error).toBeUndefined();

          // Verify the row in the database
          const db = initializeDatabase(join(iterDir, "memory.db"));
          const row = db
            .prepare("SELECT * FROM extracted_memories WHERE user_id = ?")
            .get(params.userId) as Record<string, unknown>;

          expect(row).toBeDefined();
          expect(row.content_en).toBe(params.contentEn.trim());
          expect(row.content_original).toBe(params.contentOriginal.trim());
          expect(row.memory_type).toBe(params.memoryType);
          expect(row.preserve_original).toBe(1); // true stored as 1
          expect(row.emotion_score).toBe(params.emotionScore);

          if (params.keyword) {
            expect(row.preserved_keyword).toBe(params.keyword.trim());
          } else {
            expect(row.preserved_keyword).toBeNull();
          }

          db.close();
        } finally {
          iterManager.close();
          rmSync(iterDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 30, interruptAfterTimeLimit: 15000 },
    );
  });
});

describe("instantStore — Property 3: Instant Store Rejects Invalid Inputs", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "is-prop3-"));
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Validates: Requirements 2.2, 3.1
   *
   * For any params with empty contentEn or empty contentOriginal,
   * returns { stored: false } and no DB row inserted.
   */
  it("rejects params with empty contentEn and inserts no row", async () => {
    const paramsWithEmptyContentEn = fc.record({
      userId: fc.integer({ min: 1, max: 999999 }),
      contentEn: fc.constant(""),
      contentOriginal: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
      memoryType: validMemoryType,
      emotionScore: fc.integer({ min: -5, max: 5 }),
      keyword: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
    });

    await fc.assert(
      fc.asyncProperty(paramsWithEmptyContentEn, async (params) => {
        const result = await manager.editor.instantStore(params);

        expect(result.stored).toBe(false);
        expect(result.memoriesCount).toBe(0);

        // Verify no row was inserted
        const db = initializeDatabase(join(tmpDir, "memory.db"));
        const count = db.prepare("SELECT COUNT(*) as cnt FROM extracted_memories").get() as { cnt: number };
        expect(count.cnt).toBe(0);
        db.close();
      }),
      { numRuns: 30, interruptAfterTimeLimit: 15000 },
    );
  });

  it("rejects params with empty contentOriginal and inserts no row", async () => {
    const paramsWithEmptyContentOriginal = fc.record({
      userId: fc.integer({ min: 1, max: 999999 }),
      contentEn: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
      contentOriginal: fc.constant(""),
      memoryType: validMemoryType,
      emotionScore: fc.integer({ min: -5, max: 5 }),
      keyword: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
    });

    await fc.assert(
      fc.asyncProperty(paramsWithEmptyContentOriginal, async (params) => {
        const result = await manager.editor.instantStore(params);

        expect(result.stored).toBe(false);
        expect(result.memoriesCount).toBe(0);

        // Verify no row was inserted
        const db = initializeDatabase(join(tmpDir, "memory.db"));
        const count = db.prepare("SELECT COUNT(*) as cnt FROM extracted_memories").get() as { cnt: number };
        expect(count.cnt).toBe(0);
        db.close();
      }),
      { numRuns: 30, interruptAfterTimeLimit: 15000 },
    );
  });

  it("rejects params with whitespace-only content and inserts no row", async () => {
    const whitespaceOnly = fc.stringOf(fc.constant(" "), { minLength: 1 });

    const paramsWithWhitespaceContent = fc.record({
      userId: fc.integer({ min: 1, max: 999999 }),
      contentEn: whitespaceOnly,
      contentOriginal: whitespaceOnly,
      memoryType: validMemoryType,
      emotionScore: fc.integer({ min: -5, max: 5 }),
      keyword: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
    });

    await fc.assert(
      fc.asyncProperty(paramsWithWhitespaceContent, async (params) => {
        const result = await manager.editor.instantStore(params);

        expect(result.stored).toBe(false);
        expect(result.memoriesCount).toBe(0);

        // Verify no row was inserted
        const db = initializeDatabase(join(tmpDir, "memory.db"));
        const count = db.prepare("SELECT COUNT(*) as cnt FROM extracted_memories").get() as { cnt: number };
        expect(count.cnt).toBe(0);
        db.close();
      }),
      { numRuns: 30, interruptAfterTimeLimit: 15000 },
    );
  });
});

describe("instantStore — Property 4: Watermark Advance Prevents Heartbeat Re-Extraction", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "is-prop4-"));
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Validates: Requirements 4.1, 4.2
   *
   * For any chat where instantStore() succeeds, a subsequent processTranscripts()
   * does not re-extract messages up to that timestamp.
   */
  it("instantStore does not advance watermark (extraction watermark is sleep-only)", { timeout: 30_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 999999 }),
        fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        async (userId, content) => {
          const iterDir = mkdtempSync(join(tmpdir(), "is-p4-iter-"));
          const iterManager = new MemoryManager(makeMemoryTestConfig(iterDir));
          await iterManager.initialize();

          try {
            const db = getMemoryDb(iterManager)!;

            db.prepare(
              "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
            ).run(userId, "sess-test", "user", content, Date.now() - 60_000);

            const result = await iterManager.editor.instantStore({
              userId,
              contentEn: "Test memory",
              contentOriginal: "Test memory",
              memoryType: "fact",
              emotionScore: 0,
            });

            expect(result.stored).toBe(true);

            // Watermark should NOT be advanced by instantStore
            const watermarkRow = db
              .prepare("SELECT last_processed_timestamp FROM extraction_watermarks WHERE user_id = ?")
              .get(userId) as { last_processed_timestamp: number } | undefined;

            expect(watermarkRow).toBeUndefined();
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

// #825: Store-time contradiction detection
describe("instantStore — store-time contradiction detection", () => {
  let tmpDir: string;
  let mgr: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "contradict-store-"));
    mgr = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await mgr.initialize();
  });

  afterEach(() => {
    mgr.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sets valid_to on old memory when new one contradicts it", async () => {
    await mgr.editor.instantStore({
      userId: "u1", contentEn: "I use VS Code for editing", contentOriginal: "VS Code-ot használok",
      memoryType: "preference", emotionScore: 0, topic: "tools",
    });

    const result = await mgr.editor.instantStore({
      userId: "u1", contentEn: "I no longer use VS Code, switched from VS Code to Zed",
      contentOriginal: "Már nem használok VS Code-ot, Zed-re váltottam",
      memoryType: "preference", emotionScore: 0, topic: "tools",
    });

    expect(result.stored).toBe(true);
    expect(result.contradicted).toBeDefined();
    expect(result.contradicted!.content).toContain("VS Code");

    const db = getMemoryDb(mgr)!;
    const old = db.prepare("SELECT valid_to FROM extracted_memories WHERE id = ?").get(result.contradicted!.id) as { valid_to: string };
    expect(old.valid_to).toBeTruthy();
  });

  it("does not flag non-contradicting memories in same topic", async () => {
    await mgr.editor.instantStore({
      userId: "u1", contentEn: "I use VS Code for editing", contentOriginal: "VS Code-ot használok",
      memoryType: "preference", emotionScore: 0, topic: "tools",
    });

    const result = await mgr.editor.instantStore({
      userId: "u1", contentEn: "I also use Warp as my terminal", contentOriginal: "Warp-ot is használok terminálnak",
      memoryType: "preference", emotionScore: 0, topic: "tools",
    });

    expect(result.stored).toBe(true);
    expect(result.contradicted).toBeUndefined();
  });

  it("skips contradiction check for topic=general", async () => {
    await mgr.editor.instantStore({
      userId: "u1", contentEn: "I use VS Code for editing", contentOriginal: "VS Code",
      memoryType: "fact", emotionScore: 0, topic: "general",
    });

    const result = await mgr.editor.instantStore({
      userId: "u1", contentEn: "I no longer use VS Code, switched from VS Code to something else",
      contentOriginal: "nem", memoryType: "fact", emotionScore: 0, topic: "general",
    });

    expect(result.contradicted).toBeUndefined();
  });
});
