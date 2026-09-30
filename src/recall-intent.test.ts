/**
 * #1895 — recall intent contract.
 *
 * `RecallParams.intent` declares who chose the query terms. Ambient enables
 * term selection and the raw-turn skip; explicit preserves the caller's
 * keywords verbatim (no boolean rewrite, no selection, no skip) and always
 * searches. Absent intent defaults to ambient; `selectTerms: true` without
 * intent is the deprecated ambient alias; valid intent wins; invalid intent
 * runs a conservative search.
 */
import { describe, it, expect } from "vitest";
import {
  recallSearch,
  normalizeRecallIntent,
  type RecallDeps,
  type RecallParams,
  type RecallIntent,
} from "./recall-engine.js";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";

const USER = "user-123";

function setupDb(): RecallDeps {
  const db = initializeDatabase(":memory:");
  return { db, index: new MemoryIndex(db), memoryDir: "/tmp/test-memory" };
}

function insert(deps: RecallDeps, id: number, contentEn: string, contentOriginal?: string): void {
  const now = Date.now();
  deps.db.prepare(`INSERT INTO extracted_memories
    (id, content_en, content_original, memory_type, created_at, source_timestamp, user_id, confidence, emotion_score, recall_count, relevance_score)
    VALUES (?, ?, ?, 'fact', ?, ?, ?, 3, 0, 0, 0)`).run(
    id, contentEn, contentOriginal ?? contentEn, now, now, USER,
  );
}

/** Six courtesy rows: every candidate exceeds the ceiling (max(2, 1) = 2). */
function seedCommonCorpus(deps: RecallDeps): void {
  for (let i = 1; i <= 6; i++) {
    insert(deps, i, `thanks routine note number ${i}`, `thanks routine ${i}`);
  }
}

describe("normalizeRecallIntent", () => {
  const base: RecallParams = { translated: ["x"], userId: USER };
  it("ambient stays ambient", () => {
    expect(normalizeRecallIntent({ ...base, intent: "ambient" })).toEqual({ intent: "ambient", valid: true });
  });
  it("explicit stays explicit", () => {
    expect(normalizeRecallIntent({ ...base, intent: "explicit" })).toEqual({ intent: "explicit", valid: true });
  });
  it("absent intent defaults to ambient", () => {
    expect(normalizeRecallIntent(base)).toEqual({ intent: "ambient", valid: true });
  });
  it("selectTerms:true without intent is the deprecated ambient alias", () => {
    expect(normalizeRecallIntent({ ...base, selectTerms: true })).toEqual({ intent: "ambient", valid: true });
  });
  it("selectTerms:false does not override the ambient default", () => {
    expect(normalizeRecallIntent({ ...base, selectTerms: false })).toEqual({ intent: "ambient", valid: true });
  });
  it("valid intent wins over either alias value", () => {
    expect(normalizeRecallIntent({ ...base, intent: "explicit", selectTerms: true })).toEqual({ intent: "explicit", valid: true });
    expect(normalizeRecallIntent({ ...base, intent: "explicit", selectTerms: false })).toEqual({ intent: "explicit", valid: true });
  });
  it("invalid supplied intent is reported, defaulting to a conservative search", () => {
    expect(normalizeRecallIntent({ ...base, intent: "bogus" as unknown as RecallIntent })).toEqual({
      intent: "ambient",
      valid: false,
    });
  });
});

describe("explicit preserves caller keywords and always searches", () => {
  it("literal boolean words are data, not a rewrite request", async () => {
    const deps = setupDb();
    try {
      insert(deps, 1, "the dog chased the fox");
      insert(deps, 2, "dog OR fox dilemma");
      insert(deps, 3, "unrelated zebra fact");
      const phrase = "dog OR fox";
      const explicit = await recallSearch(
        deps,
        { translated: [phrase], original: phrase, userId: USER, stages: ["Sf"], intent: "explicit" },
      );
      expect(explicit.searchSkipped).toBeUndefined();
      // The single phrase survives as the primary probe (coverage orders the
      // literal-phrase row first); the existing per-term rescue still operates
      // around it, so both rows remain reachable.
      const explicitIds = explicit.stages["Sf"]?.hits.map((h) => h.id) ?? [];
      expect(explicitIds).toContain(2);
      expect(explicitIds[0]).toBe(2);
      // Ambient control rewrites the model artifact and finds both rows.
      const ambient = await recallSearch(
        deps,
        { translated: [phrase], original: phrase, userId: USER, stages: ["Sf"], intent: "ambient" },
      );
      expect(ambient.stages["Sf"]?.hits.map((h) => h.id).sort()).toEqual([1, 2]);
    } finally {
      deps.db.close();
    }
  });

  it("all-common terms still search (selection bypassed)", async () => {
    const deps = setupDb();
    try {
      seedCommonCorpus(deps);
      const result = await recallSearch(
        deps,
        {
          translated: ["thanks", "routine"],
          original: "thanks routine note",
          userId: USER,
          stages: ["Sf"],
          intent: "explicit",
        },
      );
      expect(result.searchSkipped).toBeUndefined();
      expect(result.stageOutcomes?.["Sf"]?.status).toBe("completed");
    } finally {
      deps.db.close();
    }
  });

  it("explicit-over-alias: valid intent wins over selectTerms:true", async () => {
    const deps = setupDb();
    try {
      seedCommonCorpus(deps);
      const result = await recallSearch(
        deps,
        {
          translated: ["thanks"],
          original: "thanks",
          userId: USER,
          stages: ["Sf"],
          intent: "explicit",
          selectTerms: true,
        },
      );
      expect(result.searchSkipped).toBeUndefined();
    } finally {
      deps.db.close();
    }
  });
});

describe("ambient default and deprecated alias", () => {
  it("deprecated alias skips the all-common turn", async () => {
    const deps = setupDb();
    try {
      seedCommonCorpus(deps);
      const result = await recallSearch(
        deps,
        { translated: ["thanks"], original: "thanks", userId: USER, stages: ["Sf"], selectTerms: true },
      );
      expect(result.searchSkipped).toBe(true);
      expect(result.searchSkippedReason).toBe("no-informative-terms");
    } finally {
      deps.db.close();
    }
  });

  it("selectTerms:false keeps the ambient default (documented behavior change)", async () => {
    const deps = setupDb();
    try {
      seedCommonCorpus(deps);
      const result = await recallSearch(
        deps,
        { translated: ["thanks"], original: "thanks", userId: USER, stages: ["Sf"], selectTerms: false },
      );
      expect(result.searchSkipped).toBe(true);
    } finally {
      deps.db.close();
    }
  });
});
