import { describe, it, expect, vi } from "vitest";
import { recallSearch } from "./recall-engine.js";
import type { RecallDeps, RecallParams } from "./recall-engine.js";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function setupDb(): RecallDeps {
  const db = initializeDatabase(":memory:");
  const index = new MemoryIndex(db);
  return { db, index, memoryDir: "/tmp/test-memory", ctxStartPath: "/tmp/test-ctx.json" };
}

function insertMemory(deps: RecallDeps, id: number, contentEn: string, opts?: {
  contentOriginal?: string; preservedKeyword?: string; createdAt?: number; userId?: string;
}): void {
  const now = opts?.createdAt ?? Date.now();
  deps.db.prepare(`INSERT INTO extracted_memories
    (id, content_en, content_original, preserved_keyword, memory_type, created_at, source_timestamp, user_id, confidence, emotion_score, recall_count, relevance_score)
    VALUES (?, ?, ?, ?, 'fact', ?, ?, ?, 3, 0, 0, 0)`).run(
    id, contentEn, opts?.contentOriginal ?? contentEn, opts?.preservedKeyword ?? null,
    now, now, opts?.userId ?? "user-123",
  );
}

function baseParams(overrides?: Partial<RecallParams>): RecallParams {
  return { translated: ["puppy"], userId: "user-123", ...overrides };
}

// ── Sf stage ────────────────────────────────────────────────────────────────

describe("recallSearch — Sf stage", () => {
  it("finds memories via porter FTS5 (stemmed match)", async () => {
    const deps = setupDb();
    insertMemory(deps, 1, "The puppy was running in the garden");
    const result = await recallSearch(deps, baseParams({ translated: ["puppy"] }));
    expect(result.stages["Sf"]).toBeDefined();
    expect(result.stages["Sf"]!.hits.length).toBeGreaterThanOrEqual(1);
  });

  it("finds memories via trigram (substring match)", async () => {
    const deps = setupDb();
    insertMemory(deps, 1, "The deployment was successful on the server");
    // "deploy" is a substring — trigram matches it
    const result = await recallSearch(deps, baseParams({ translated: ["deploy"] }));
    expect(result.results.some(r => r.content.includes("deployment"))).toBe(true);
  });

  it("falls back to content_original trigram when content_en has no match", async () => {
    const deps = setupDb();
    insertMemory(deps, 1, "Swedish switchman story", { contentOriginal: "A svéd váltókezelő története" });
    // Search in Hungarian — should find via content_original trigram
    const result = await recallSearch(deps, baseParams({ translated: ["switchman"], original: "valtokezelo" }));
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });

  it("includes preserved_keyword in trigram search", async () => {
    const deps = setupDb();
    insertMemory(deps, 1, "User has a small dog", { preservedKeyword: "kiskutya" });
    const result = await recallSearch(deps, baseParams({ translated: ["kiskutya"] }));
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Short-circuit ───────────────────────────────────────────────────────────

describe("recallSearch — short-circuit", () => {
  it("sets shortCircuitAfter=Sf when Sf fills the limit", async () => {
    const deps = setupDb();
    for (let i = 1; i <= 15; i++) {
      insertMemory(deps, i, `Memory about puppies number ${i}`);
    }
    const result = await recallSearch(deps, baseParams({ limit: 10 }));
    expect(result.shortCircuitAfter).toBe("Sf");
  });

  it("does not short-circuit with few results", async () => {
    const deps = setupDb();
    insertMemory(deps, 1, "One puppy memory");
    const result = await recallSearch(deps, baseParams({ limit: 10 }));
    expect(result.shortCircuitAfter).toBeNull();
  });
});

// ── Per-stage results ───────────────────────────────────────────────────────

describe("recallSearch — per-stage results", () => {
  it("returns per-stage hits and timing", async () => {
    const deps = setupDb();
    insertMemory(deps, 1, "A puppy was found in the park");
    const result = await recallSearch(deps, baseParams());
    expect(result.stages["Sf"]).toBeDefined();
    expect(typeof result.stages["Sf"]!.ms).toBe("number");
  });

  it("collects extractedIds for recall count bumping", async () => {
    const deps = setupDb();
    insertMemory(deps, 42, "A puppy named Rex");
    const result = await recallSearch(deps, baseParams());
    expect(result.extractedIds).toContain(42);
  });
});

// ── Dedup ───────────────────────────────────────────────────────────────────

describe("recallSearch — deduplication", () => {
  it("deduplicates by memory ID across stages", async () => {
    const deps = setupDb();
    insertMemory(deps, 1, "A puppy was found");
    const result = await recallSearch(deps, baseParams());
    // Same memory should appear only once even if multiple sub-queries find it
    const matching = result.results.filter(r => r.content.includes("puppy"));
    expect(matching.length).toBe(1);
  });
});

// ── Limit ───────────────────────────────────────────────────────────────────

describe("recallSearch — limit", () => {
  it("respects limit parameter", async () => {
    const deps = setupDb();
    for (let i = 1; i <= 20; i++) {
      insertMemory(deps, i, `Puppy memory number ${i}`);
    }
    const result = await recallSearch(deps, baseParams({ limit: 5 }));
    expect(result.results.length).toBeLessThanOrEqual(5);
  });
});

// ── Stage selection ─────────────────────────────────────────────────────────

describe("recallSearch — stage selection", () => {
  it("only runs requested stages", async () => {
    const deps = setupDb();
    insertMemory(deps, 1, "A puppy in the park");
    const result = await recallSearch(deps, baseParams({ stages: ["Sf"] }));
    expect(result.stages["Sf"]).toBeDefined();
    expect(result.stages["Ss"]).toBeUndefined();
    expect(result.stages["S6"]).toBeUndefined();
  });
});
