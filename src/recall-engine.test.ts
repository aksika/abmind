import { describe, it, expect, vi } from "vitest";
import { recallSearch } from "./recall-engine.js";
import type { RecallDeps, RecallParams } from "./recall-engine.js";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import { generateSignature } from "./signature-generator.js";
import { _resetAbmindEnv } from "./env-schema.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function setupDb(): RecallDeps {
  const db = initializeDatabase(":memory:");
  const index = new MemoryIndex(db);
  return { db, index, memoryDir: "/tmp/test-memory" };
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

// ── Stage participation (#1861) ─────────────────────────────────────────────

describe("recallSearch — stage outcomes", () => {
  it("a full Sf pool no longer suppresses Ss and Se", async () => {
    const deps = setupDb();
    for (let i = 1; i <= 15; i++) {
      insertMemory(deps, i, `Memory about puppies number ${i}`);
    }
    const result = await recallSearch(deps, baseParams({ limit: 10 }));
    expect(result.stageOutcomes?.["Sf"]?.status).toBe("completed");
    expect(result.stageOutcomes?.["Sf"]?.hitCount).toBeGreaterThanOrEqual(10);
    expect(result.stageOutcomes?.["Ss"]?.status).toBe("completed");
    // No provider in this fixture: the stage is explicitly unavailable, not skipped silently.
    expect(result.stageOutcomes?.["Se"]).toEqual({ status: "no-provider", hitCount: 0 });
    expect(result.stageOutcomes?.["S6"]?.status).toBe("completed");
  });

  it("reports not-requested for stages outside the requested list", async () => {
    const deps = setupDb();
    insertMemory(deps, 1, "One puppy memory");
    const result = await recallSearch(deps, baseParams({ stages: ["Sf"] }));
    expect(result.stageOutcomes?.["Sf"]?.status).toBe("completed");
    expect(result.stageOutcomes?.["Se"]?.status).toBe("not-requested");
    expect(result.stageOutcomes?.["Ss"]?.status).toBe("not-requested");
    expect(result.stageOutcomes?.["S6"]?.status).toBe("not-requested");
  });

  it("reports completed with zero hits when a stage runs and finds nothing", async () => {
    const deps = setupDb();
    insertMemory(deps, 1, "A puppy in the park");
    const result = await recallSearch(deps, baseParams({ translated: ["xyzzynotfound"] }));
    expect(result.stageOutcomes?.["Sf"]).toEqual({ status: "completed", hitCount: 0 });
    expect(result.stageOutcomes?.["Ss"]).toEqual({ status: "completed", hitCount: 0 });
  });

  it("reports disabled when embeddings are turned off, without calling the provider", async () => {
    process.env["EMBEDDING_ENABLED"] = "false";
    _resetAbmindEnv();
    try {
      const deps = setupDb();
      const embedText = vi.fn(async () => new Float32Array([0.1, 0.2, 0.3]));
      deps.embeddingProvider = { embedText, batchEmbed: async () => [], dimensions: 3, name: "test-provider" };
      insertMemory(deps, 1, "A puppy in the park");
      const result = await recallSearch(deps, baseParams({ stages: ["Sf", "Se"] }));
      expect(result.stageOutcomes?.["Se"]).toEqual({ status: "disabled", hitCount: 0 });
      expect(embedText).not.toHaveBeenCalled();
    } finally {
      delete process.env["EMBEDDING_ENABLED"];
      _resetAbmindEnv();
    }
  });

  it("bounds the Se wait with a deadline and still runs the remaining stages", async () => {
    process.env["RECALL_SE_WAIT_MS"] = "20";
    try {
      const deps = setupDb();
      deps.embeddingProvider = {
        embedText: () => new Promise<Float32Array | null>((resolve) => setTimeout(() => resolve(null), 150)),
        batchEmbed: async () => [],
        dimensions: 3,
        name: "slow-provider",
      };
      insertMemory(deps, 1, "A puppy in the park");
      const t0 = Date.now();
      const result = await recallSearch(deps, baseParams({ stages: ["Sf", "Se", "Ss"] }));
      expect(Date.now() - t0).toBeLessThan(120);
      expect(result.stageOutcomes?.["Se"]).toEqual({ status: "deadline", hitCount: 0 });
      expect(result.stageOutcomes?.["Ss"]?.status).toBe("completed");
    } finally {
      delete process.env["RECALL_SE_WAIT_MS"];
    }
  });

  it("includes candidates found only by Se or Ss when Sf fills its limit", async () => {
    const deps = setupDb();
    // Porter-stem collisions fill the Sf pool without earning the strong floor.
    for (let i = 1; i <= 15; i++) {
      insertMemory(deps, i, `She felt happy number ${i}`);
    }
    // Se-only candidate: vector identical to the query, text invisible to Sf.
    const embedding = Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer);
    deps.db.prepare(`INSERT INTO extracted_memories
      (id, content_en, content_original, memory_type, created_at, source_timestamp, user_id, confidence, emotion_score, recall_count, relevance_score, embedding)
      VALUES (?, ?, ?, 'fact', ?, ?, ?, 3, 0, 0, 0, ?)`).run(
      101, "azure quartz canyon", "azure quartz canyon", Date.now(), Date.now(), "user-123", embedding);
    // Ss-only candidate: signature of the query, unrelated text.
    deps.db.prepare(`INSERT INTO extracted_memories
      (id, content_en, content_original, memory_type, created_at, source_timestamp, user_id, confidence, emotion_score, recall_count, relevance_score, signature)
      VALUES (?, ?, ?, 'fact', ?, ?, ?, 3, 0, 0, 0, ?)`).run(
      102, "marble lintel", "marble lintel", Date.now(), Date.now(), "user-123",
      Buffer.from(generateSignature("happiness")));
    deps.embeddingProvider = {
      embedText: async () => new Float32Array([0.1, 0.2, 0.3]),
      batchEmbed: async () => [new Float32Array([0.1, 0.2, 0.3])],
      dimensions: 3,
      name: "test-provider",
    };

    const result = await recallSearch(deps, baseParams({ translated: ["happiness"], limit: 10 }));
    expect(result.stageOutcomes?.["Sf"]?.hitCount).toBeGreaterThanOrEqual(10);
    expect(result.stageOutcomes?.["Se"]?.status).toBe("completed");
    expect(result.stageOutcomes?.["Se"]?.hitCount).toBeGreaterThanOrEqual(1);
    expect(result.stageOutcomes?.["Ss"]?.status).toBe("completed");
    expect(result.stageOutcomes?.["Ss"]?.hitCount).toBeGreaterThanOrEqual(1);
    const resultIds = result.results.map((r) => r.id);
    expect(resultIds).toContain(101);
    expect(resultIds).toContain(102);
  });
});

// ── Weak evidence (#1861) ───────────────────────────────────────────────────

describe("recallSearch — weak evidence", () => {
  it("reports weak evidence on a zero-hit search", async () => {
    const deps = setupDb();
    insertMemory(deps, 1, "A puppy in the park");
    const result = await recallSearch(deps, baseParams({ translated: ["xyzzynotfound"] }));
    expect(result.results).toHaveLength(0);
    expect(result.weakEvidence).toBe(true);
  });

  it("reports weak evidence when no candidate covers every supplied keyword", async () => {
    const deps = setupDb();
    insertMemory(deps, 1, "A puppy was found in the park");
    const result = await recallSearch(deps, baseParams({ translated: ["puppy", "fox"] }));
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.weakEvidence).toBe(true);
  });

  it("an exact token-boundary match for every keyword is not weak", async () => {
    const deps = setupDb();
    insertMemory(deps, 1, "The fox and the puppy played in the park");
    const result = await recallSearch(deps, baseParams({ translated: ["puppy", "fox"] }));
    expect(result.weakEvidence).toBe(false);
  });

  it("a substring collision is not an exact topical match", async () => {
    const deps = setupDb();
    insertMemory(deps, 1, "The watchdog guards the foxglove patch");
    const result = await recallSearch(deps, baseParams({ translated: ["dog", "fox"] }));
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.weakEvidence).toBe(true);
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

// ── Se embedding stage ─────────────────────────────────────────────────────

describe("recallSearch — Se embedding stage", () => {
  it("skips Se when no embeddingProvider is given (no Ollama fallback)", async () => {
    const deps = setupDb();
    insertMemory(deps, 1, "Puppy in the garden");
    const result = await recallSearch(deps, baseParams({ stages: ["Sf", "Se"] }));
    expect(result.stages["Sf"]).toBeDefined();
    expect(result.stages["Se"]).toBeUndefined();
    expect(result.stageOutcomes?.["Se"]).toEqual({ status: "no-provider", hitCount: 0 });
  });

  it("runs Se when embeddingProvider is provided", async () => {
    const deps = setupDb();
    deps.embeddingProvider = {
      embedText: async () => new Float32Array([0.1, 0.2, 0.3]),
      batchEmbed: async () => [new Float32Array([0.1, 0.2, 0.3])],
      dimensions: 3,
      name: "test-provider",
    };
    insertMemory(deps, 1, "Puppy in the garden");
    const result = await recallSearch(deps, baseParams({ stages: ["Sf", "Se"] }));
    expect(result.stages["Sf"]).toBeDefined();
    // Se runs; may produce zero vec results (no vec_memories rows) but stage is recorded
    expect(result.stages["Se"]).toBeDefined();
  });

  it("provider embedText failure does not crash recall", async () => {
    const deps = setupDb();
    deps.embeddingProvider = {
      embedText: async () => null,
      batchEmbed: async () => [null],
      dimensions: 3,
      name: "test-provider",
    };
    insertMemory(deps, 1, "Puppy in the garden");
    const result = await recallSearch(deps, baseParams({ stages: ["Sf", "Se"] }));
    expect(result.stages["Sf"]).toBeDefined();
    expect(result.stages["Se"]).toBeUndefined();
    expect(result.stageOutcomes?.["Se"]).toEqual({ status: "failed", hitCount: 0 });
  });
});

// ── FTS recall without embeddings ─────────────────────────────────────────

describe("recallSearch — FTS without embeddings", () => {
  it("FTS recall works when Se is skipped (no provider)", async () => {
    const deps = setupDb();
    insertMemory(deps, 1, "FTS-only memory about cats");
    const result = await recallSearch(deps, baseParams({ translated: ["cats"] }));
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.some(r => r.content.includes("cats"))).toBe(true);
  });

  it("FTS recall handles boolean operator queries without embeddings", async () => {
    const deps = setupDb();
    insertMemory(deps, 1, "Puppy cat");
    insertMemory(deps, 2, "Puppy dog");
    const result = await recallSearch(deps, baseParams({ translated: ["puppy OR dog"] }));
    expect(result.results.length).toBeGreaterThanOrEqual(1);
  });
});
