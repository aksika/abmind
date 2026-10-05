/**
 * #1913 Item 1 — focused verification retains supporting evidence.
 *
 * Regression evidence for the 2026-10-05 incident (synthetic English
 * analogues, no user data): focused fact reads and one diluted multi-topic
 * verification query must all expose their supporting facts on the
 * deterministic lexical path (porter + per-term trigram probes).
 *
 * Recorded boundary (2026-10-05, current dev): lexical retrieval is healthy —
 * focused and diluted queries retrieve every supporting fact, and a guardrail
 * lesson coexists with (never suppresses) its fact. The incident's inversion
 * (fact absent from top-10, lesson ranked above facts, embedding-ranked
 * distractors on top) did not reproduce without the live embedding stage and
 * live recall histories; that fusion weighting is an unverified residual, and
 * the agent's "no stored memory" conclusion over evidence that contained
 * support is a model-reasoning residual. No provider, no embeddings.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import { recallSearch, type RecallDeps } from "./recall-engine.js";
import { initAbmindEnv, _resetAbmindEnv } from "./env-schema.js";

const ENV_KEYS = ["SYSTEM1", "SYSTEM1_RECALL"];

function row(db: Database.Database, id: number, contentEn: string): void {
  const now = Date.now();
  db.prepare(`INSERT INTO extracted_memories
    (id, content_en, content_original, memory_type, created_at, source_timestamp, user_id, confidence, emotion_score, recall_count, relevance_score, semantic_revision)
    VALUES (?, ?, ?, 'fact', ?, ?, 'user-123', 3, 0, 0, 0, 1)`).run(
    id, contentEn, contentEn, now, now,
  );
}

function seed(db: Database.Database): void {
  row(db, 101, "User clarified Vincent refers to Vincent Vega from Pulp Fiction, in the Are we happy Vincent joke context. Do not confuse with other Vincents.");
  row(db, 102, "Memory test items: puppy size is 5 cm, approximately 2 inches. Tuesday means Belgium. Wednesday means Netherlands.");
  row(db, 103, "Old inside joke memory test: if Tuesday then Belgium, if Wednesday then Netherlands.");
  row(db, 104, "Do not make up stories: ask about references instead of hallucinating, Vincent story.");
  row(db, 105, "A family lives in a small town with two children and a dog.");
  row(db, 106, "Tomorrow");
}

function deps(db: Database.Database): RecallDeps {
  return { db, index: new MemoryIndex(db), memoryDir: "/tmp/test-memory-1913" };
}

function idsOf(res: { results: Array<{ id?: number | null }> }): number[] {
  return res.results.map((h) => h.id).filter((id): id is number => typeof id === "number");
}

describe("#1913 — focused verification exposes supporting evidence", () => {
  let saved: Record<string, string | undefined>;
  let db: Database.Database;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    _resetAbmindEnv();
    db = initializeDatabase(":memory:");
    seed(db);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetAbmindEnv();
    vi.restoreAllMocks();
    db.close();
  });

  async function recall(terms: string[]) {
    initAbmindEnv();
    return recallSearch(deps(db), { translated: terms, userId: "user-123", limit: 10, intent: "explicit" });
  }

  it("focused reads expose their facts, lesson coexists without suppression", async () => {
    const vincent = idsOf(await recall(["vincent"]));
    expect(vincent).toContain(101);
    expect(vincent).toContain(104);

    const belgium = idsOf(await recall(["belgium", "tuesday"]));
    expect(belgium).toContain(102);
    expect(belgium).toContain(103);
    expect(idsOf(await recall(["puppy", "size"]))).toContain(102);
  });

  it("a diluted multi-topic query retains every per-claim fact", async () => {
    const first = idsOf(await recall(["vincent", "belgium", "tuesday"]));
    for (const id of [101, 102, 103, 104]) expect(first).toContain(id);

    // Deterministic: a repeated diluted search exposes the same evidence.
    const second = idsOf(await recall(["vincent", "belgium", "tuesday"]));
    expect(second).toEqual(first);
  });

  it("exposes contradictory evidence and distinguishes a joke from a real trip", async () => {
    row(db, 107, "User later corrected Vincent: the reference is Vincent van Gogh, not Vincent Vega from Pulp Fiction.");
    row(db, 108, "The real Belgium trip happened on Friday. Tuesday means Belgium only in the inside joke.");
    const vincent = await recall(["vincent"]);
    expect(idsOf(vincent)).toEqual(expect.arrayContaining([101, 104, 107]));
    expect(vincent.results.find((hit) => hit.id === 107)?.content).toContain("later corrected");
    const belgium = await recall(["belgium"]);
    expect(idsOf(belgium)).toEqual(expect.arrayContaining([103, 108]));
    expect(belgium.results.find((hit) => hit.id === 108)?.content).toContain("Friday");
  });

  it("does not supply supporting facts for an unsupported claim; a later focused read still does", async () => {
    expect(idsOf(await recall(["unicorn", "moonflight"]))).toEqual([]);
    expect(idsOf(await recall(["vincent"]))).toContain(101);
  });
});
