/**
 * #1867 — term selection: drop supplied translated terms whose measured corpus
 * document frequency makes them uninformative, before retrieval.
 *
 * Protection: the dog/fox query shape from docs/plans/1861-draft-recall-
 * lexical-noise.md — relational filler ("looks", "like") must not decide the
 * pool while topical terms ("dog", "fox") are present. Hungarian filler is
 * covered by the same measured rule with no hardcoded list.
 */
import { describe, it, expect } from "vitest";
import { recallSearch } from "./recall-engine.js";
import type { RecallDeps, RecallParams } from "./recall-engine.js";
import { selectInformativeTerms } from "./trigram-search.js";
import type { SfOptions } from "./trigram-search.js";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";

function setupDb(): RecallDeps {
  const db = initializeDatabase(":memory:");
  const index = new MemoryIndex(db);
  return { db, index, memoryDir: "/tmp/test-memory" };
}

function insertMemory(deps: RecallDeps, id: number, contentEn: string, opts?: {
  contentOriginal?: string; userId?: string;
}): void {
  const now = Date.now();
  deps.db.prepare(`INSERT INTO extracted_memories
    (id, content_en, content_original, preserved_keyword, memory_type, created_at, source_timestamp, user_id, confidence, emotion_score, recall_count, relevance_score)
    VALUES (?, ?, ?, ?, 'fact', ?, ?, ?, 3, 0, 0, 0)`).run(
    id, contentEn, opts?.contentOriginal ?? contentEn, null,
    now, now, opts?.userId ?? "user-123",
  );
}

function searchOpts(userId = "user-123"): SfOptions {
  return { translated: [], userId, limit: 10, maxClassification: 2 };
}

function baseParams(overrides?: Partial<RecallParams>): RecallParams {
  return { translated: ["dog", "fox"], userId: "user-123", ...overrides };
}

/** Corpus where English filler dominates and topical terms are rare. */
function seedFillerCorpus(deps: RecallDeps): void {
  insertMemory(deps, 1, "The dog chased the fox through the meadow");
  insertMemory(deps, 2, "It looks like rain today over the hills");
  insertMemory(deps, 3, "She looks like her sister in that photo");
  insertMemory(deps, 4, "This looks like a good place for lunch");
  insertMemory(deps, 5, "He walks like his father walks");
  insertMemory(deps, 6, "The soup tastes like grandmother made it");
  insertMemory(deps, 7, "It looks like the train is delayed again");
}

describe("selectInformativeTerms", () => {
  it("drops high-df filler while keeping rare topical terms", () => {
    const deps = setupDb();
    seedFillerCorpus(deps);
    const kept = selectInformativeTerms(deps.db, searchOpts(), ["dog", "fox", "looks", "like"]);
    expect(kept).toContain("dog");
    expect(kept).toContain("fox");
    expect(kept).not.toContain("looks");
    expect(kept).not.toContain("like");
  });

  it("drops high-df Hungarian filler with no hardcoded list", () => {
    const deps = setupDb();
    insertMemory(deps, 1, "Morgenson the Swedish switchman told a joke", { contentOriginal: "Morgenson svéd váltókezelő viccet mesélt" });
    insertMemory(deps, 2, "hogy van a helyzet ezzel a dologgal", { contentOriginal: "hogy van" });
    insertMemory(deps, 3, "hogy van az idő ma reggel", { contentOriginal: "hogy van" });
    insertMemory(deps, 4, "hogy van a családod mostanában", { contentOriginal: "hogy van" });
    insertMemory(deps, 5, "hogy van a kutya a kertben", { contentOriginal: "hogy van" });
    insertMemory(deps, 6, "hogy van a macska a házban", { contentOriginal: "hogy van" });
    const kept = selectInformativeTerms(deps.db, searchOpts(), ["Morgenson", "hogy", "van"]);
    expect(kept).toContain("Morgenson");
    expect(kept).not.toContain("hogy");
    expect(kept).not.toContain("van");
  });

  it("never returns empty: an all-filler set returns the input unchanged", () => {
    const deps = setupDb();
    seedFillerCorpus(deps);
    expect(selectInformativeTerms(deps.db, searchOpts(), ["looks", "like"])).toEqual(["looks", "like"]);
  });

  it("a single term is never dropped", () => {
    const deps = setupDb();
    seedFillerCorpus(deps);
    expect(selectInformativeTerms(deps.db, searchOpts(), ["looks"])).toEqual(["looks"]);
  });

  it("an empty set stays empty", () => {
    const deps = setupDb();
    seedFillerCorpus(deps);
    expect(selectInformativeTerms(deps.db, searchOpts(), [])).toEqual([]);
  });

  it("a tiny corpus keeps everything (no signal to drop on)", () => {
    const deps = setupDb();
    insertMemory(deps, 1, "The dog looks like a fox");
    expect(selectInformativeTerms(deps.db, searchOpts(), ["dog", "looks"])).toEqual(["dog", "looks"]);
  });
});

describe("recallSearch — intent contract (#1895)", () => {
  it("explicit keeps consume-as-supplied behavior", async () => {
    const deps = setupDb();
    seedFillerCorpus(deps);
    const result = await recallSearch(deps, baseParams({ translated: ["dog", "fox", "looks", "like"], intent: "explicit" }));
    // Filler-only memory 2 is in the Sf pool when selection is off.
    expect(result.stages["Sf"]?.hits.map((h) => h.id)).toContain(2);
  });

  it("absent intent defaults to ambient and selects", async () => {
    const deps = setupDb();
    seedFillerCorpus(deps);
    const result = await recallSearch(deps, baseParams({ translated: ["dog", "fox", "looks", "like"] }));
    const sfIds = result.stages["Sf"]?.hits.map((h) => h.id) ?? [];
    expect(sfIds).toContain(1);
    expect(sfIds).not.toContain(2);
  });

  it("deprecated alias removes the filler-only distractor from the Sf pool", async () => {
    const deps = setupDb();
    seedFillerCorpus(deps);
    const result = await recallSearch(deps, baseParams({ translated: ["dog", "fox", "looks", "like"], selectTerms: true }));
    const sfIds = result.stages["Sf"]?.hits.map((h) => h.id) ?? [];
    expect(sfIds).toContain(1);
    expect(sfIds).not.toContain(2);
  });

  it("alias keeps the topical memory ranked above the filler distractor", async () => {
    const deps = setupDb();
    seedFillerCorpus(deps);
    const result = await recallSearch(deps, baseParams({ translated: ["dog", "fox", "looks", "like"], selectTerms: true, limit: 5 }));
    const ids = result.results.map((h) => h.id);
    expect(ids).toContain(1);
    if (ids.includes(2)) {
      expect(ids.indexOf(1)).toBeLessThan(ids.indexOf(2));
    }
  });

  it("alias with a single term behaves like explicit", async () => {
    const deps = setupDb();
    seedFillerCorpus(deps);
    const explicit = await recallSearch(deps, baseParams({ translated: ["dog"], intent: "explicit" }));
    const aliased = await recallSearch(deps, baseParams({ translated: ["dog"], selectTerms: true }));
    expect(aliased.results.map((h) => h.id)).toEqual(explicit.results.map((h) => h.id));
  });
});
