/**
 * #1877 — skip a search that cannot discriminate anything.
 *
 * The decision is the measured document frequency of the supplied terms in the
 * user's own corpus, the same measure #1867 uses to drop uninformative terms.
 * No stopword list, no language detection, no per-language cue lists: a turn
 * made of tokens that are spread across the whole store carries nothing to
 * retrieve, in any language. These tests prove that for English and Hungarian
 * with identical code paths, and prove the guards: informative terms still
 * search, a mixed turn searches on its informative subset, non-auto-recall
 * callers never skip, and a small corpus never skips.
 */
import { describe, it, expect } from "vitest";
import { recallSearch } from "./recall-engine.js";
import type { RecallDeps, RecallParams } from "./recall-engine.js";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";

function setupDb(): RecallDeps {
  const db = initializeDatabase(":memory:");
  return { db, index: new MemoryIndex(db), memoryDir: "/tmp/test-memory" };
}

function insert(deps: RecallDeps, id: number, contentEn: string): void {
  const now = Date.now();
  deps.db.prepare(`INSERT INTO extracted_memories
    (id, content_en, content_original, memory_type, created_at, source_timestamp, user_id, confidence, emotion_score, recall_count, relevance_score)
    VALUES (?, ?, ?, 'fact', ?, ?, 'user-123', 3, 0, 0, 0)`).run(id, contentEn, contentEn, now, now);
}

function params(translated: string[], overrides?: Partial<RecallParams>): RecallParams {
  return { translated, userId: "user-123", limit: 10, selectTerms: true, stages: ["Sf"], ...overrides };
}

/** Corpus where a courtesy token is spread across most memories and the
 *  topical tokens are rare — the same shape in either language. */
function seedCourtesyCorpus(deps: RecallDeps, courtesy: string, topical: string): void {
  insert(deps, 1, `${topical} runs the nightly migration before the release`);
  insert(deps, 2, `${topical} owns the staging rollback procedure`);
  for (let i = 3; i <= 14; i++) {
    insert(deps, i, `${courtesy} ${courtesy} note ${i} about the daily routine`);
  }
}

describe("#1877 — uninformative turns skip the search", () => {
  it("skips an all-courtesy English turn without running any stage", async () => {
    const deps = setupDb();
    try {
      seedCourtesyCorpus(deps, "thanks", "migration");
      const result = await recallSearch(deps, params(["thanks"]));
      expect(result.searchSkipped).toBe(true);
      expect(result.searchSkippedReason).toBe("no-informative-terms");
      expect(result.results).toEqual([]);
      expect(result.weakEvidence).toBe(true);
      for (const outcome of Object.values(result.stageOutcomes ?? {})) {
        expect(outcome.status).toBe("not-requested");
        expect(outcome.hitCount).toBe(0);
      }
    } finally {
      deps.db.close();
    }
  });

  it("skips the equivalent Hungarian turn through the same code path", async () => {
    const deps = setupDb();
    try {
      seedCourtesyCorpus(deps, "köszi", "migráció");
      const result = await recallSearch(deps, params(["köszi"]));
      expect(result.searchSkipped).toBe(true);
      expect(result.searchSkippedReason).toBe("no-informative-terms");
      expect(result.results).toEqual([]);
    } finally {
      deps.db.close();
    }
  });

  it("searches when a supplied term is informative", async () => {
    const deps = setupDb();
    try {
      seedCourtesyCorpus(deps, "thanks", "migration");
      const result = await recallSearch(deps, params(["migration"]));
      expect(result.searchSkipped).toBeUndefined();
      expect(result.results.length).toBeGreaterThan(0);
    } finally {
      deps.db.close();
    }
  });

  it("searches a mixed turn on its informative subset", async () => {
    const deps = setupDb();
    try {
      seedCourtesyCorpus(deps, "köszi", "migráció");
      const result = await recallSearch(deps, params(["köszi", "migráció"]));
      expect(result.searchSkipped).toBeUndefined();
      expect(result.results.length).toBeGreaterThan(0);
    } finally {
      deps.db.close();
    }
  });

  it("never skips for callers that did not ask for term selection", async () => {
    const deps = setupDb();
    try {
      seedCourtesyCorpus(deps, "thanks", "migration");
      const result = await recallSearch(deps, params(["thanks"], { selectTerms: undefined }));
      expect(result.searchSkipped).toBeUndefined();
    } finally {
      deps.db.close();
    }
  });

  it("never skips on a corpus too small for the measure to have signal", async () => {
    const deps = setupDb();
    try {
      insert(deps, 1, "thanks for the note");
      insert(deps, 2, "thanks again for the note");
      const result = await recallSearch(deps, params(["thanks"]));
      expect(result.searchSkipped).toBeUndefined();
    } finally {
      deps.db.close();
    }
  });
});
