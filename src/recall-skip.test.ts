/**
 * #1895 — the skip judges only the raw turn.
 *
 * Ambient recall measures the raw turn's distinct tokens against the
 * eligible corpus: English porter df first, then the diacritic-stripped
 * source index on a successful English zero (token-start boundary required,
 * so mid-token substrings never count). Skip only on complete evidence with
 * every candidate over the ceiling; anything else searches. Supplied
 * translated terms shape the search that runs — they never substitute for
 * missing turn text, and informative priming never rescues a courtesy turn.
 *
 * Fixtures use the production bilingual shape: English `content_en` plus a
 * distinct Hungarian `content_original` (the old tests put Hungarian in
 * `content_en`, which never proved the production data shape).
 */
import { describe, it, expect } from "vitest";
import { recallSearch, type RecallDeps, type RecallParams, type RecallIntent } from "./recall-engine.js";
import { classifyRawTurn, measureEnglishDf, measureSourceTokenDf } from "./trigram-search.js";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";

const USER = "user-123";

function setupDb(): RecallDeps {
  const db = initializeDatabase(":memory:");
  return { db, index: new MemoryIndex(db), memoryDir: "/tmp/test-memory" };
}

function insert(
  deps: RecallDeps, id: number, contentEn: string, contentOriginal: string,
  opts?: { userId?: string; validTo?: string | null; classification?: number | null },
): void {
  const now = Date.now();
  deps.db.prepare(`INSERT INTO extracted_memories
    (id, content_en, content_original, memory_type, created_at, source_timestamp, user_id, confidence, emotion_score, recall_count, relevance_score, valid_to, classification)
    VALUES (?, ?, ?, 'fact', ?, ?, ?, 3, 0, 0, 0, ?, ?)`).run(
    id, contentEn, contentOriginal, now, now, opts?.userId ?? USER, opts?.validTo ?? null,
    opts?.classification ?? null,
  );
}

/** Ambient by default (absent intent); the raw turn is judged, never substituted. */
function params(original: string | undefined, translated: string[], overrides?: Partial<RecallParams>): RecallParams {
  return { translated, original, userId: USER, limit: 10, stages: ["Sf"], ...overrides };
}

/**
 * Production bilingual shape: two rare topical memories plus twelve courtesy
 * memories whose source token `köszi` is common in eligible originals.
 * Ceiling is max(2, floor(14 * 0.25)) = 3; courtesy df is 12.
 */
function seedBilingualCourtesyCorpus(deps: RecallDeps): void {
  insert(deps, 1, "migration owns the staging rollback procedure", "a migráció kezeli az élesítési visszagörgetést");
  insert(deps, 2, "migration runs the nightly data reload", "a migráció futtatja az éjszakai adatbetöltést");
  for (let i = 3; i <= 14; i++) {
    insert(deps, i, `daily routine note number ${i}`, `köszi szépen a napi rutinhoz ${i}`);
  }
}

function skipResult(searchSkipped: unknown): boolean {
  return searchSkipped === true;
}

describe("#1895 — production bilingual skip", () => {
  it("skips a source-courtesy turn with the existing reason and no stage runs", async () => {
    const deps = setupDb();
    try {
      seedBilingualCourtesyCorpus(deps);
      const result = await recallSearch(deps, params("köszi", ["note"]));
      expect(skipResult(result.searchSkipped)).toBe(true);
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

  it("informative priming cannot rescue the courtesy turn", async () => {
    const deps = setupDb();
    try {
      seedBilingualCourtesyCorpus(deps);
      // `migration` is informative in English, but the raw turn is courtesy:
      // the skip judges the turn, not the supplied terms.
      const result = await recallSearch(deps, params("köszi", ["migration"]));
      expect(skipResult(result.searchSkipped)).toBe(true);
    } finally {
      deps.db.close();
    }
  });

  it("ASCII-only extracted terms cannot replace the raw-turn judgment", async () => {
    const deps = setupDb();
    try {
      seedBilingualCourtesyCorpus(deps);
      // ASCII filler common in English, but the source-only turn is courtesy.
      const result = await recallSearch(deps, params("köszi szépen", ["routine", "note"]));
      expect(skipResult(result.searchSkipped)).toBe(true);
    } finally {
      deps.db.close();
    }
  });

  it("a rare topical token searches and returns its seeded memory", async () => {
    const deps = setupDb();
    try {
      seedBilingualCourtesyCorpus(deps);
      const result = await recallSearch(deps, params("köszi migrációs terv", ["migration"]));
      expect(result.searchSkipped).toBeUndefined();
      expect(result.stageOutcomes?.["Sf"]?.status).toBe("completed");
      expect(result.results.map((h) => h.id)).toContain(1);
    } finally {
      deps.db.close();
    }
  });
});

describe("#1895 — conservative decisions search", () => {
  it("missing original searches even when translated terms are common", async () => {
    const deps = setupDb();
    try {
      seedBilingualCourtesyCorpus(deps);
      const result = await recallSearch(deps, params(undefined, ["köszi"]));
      expect(result.searchSkipped).toBeUndefined();
      expect(result.stageOutcomes?.["Sf"]?.status).toBe("completed");
    } finally {
      deps.db.close();
    }
  });

  it("empty original searches", async () => {
    const deps = setupDb();
    try {
      seedBilingualCourtesyCorpus(deps);
      const result = await recallSearch(deps, params("   ", ["köszi"]));
      expect(result.searchSkipped).toBeUndefined();
    } finally {
      deps.db.close();
    }
  });

  it("a turn with no letter/digit runs searches", async () => {
    const deps = setupDb();
    try {
      seedBilingualCourtesyCorpus(deps);
      const result = await recallSearch(deps, params("!!! ??? ...", ["köszi"]));
      expect(result.searchSkipped).toBeUndefined();
    } finally {
      deps.db.close();
    }
  });

  it("unseen tokens search (zero everywhere preserves semantic/fuzzy retrieval)", async () => {
    const deps = setupDb();
    try {
      seedBilingualCourtesyCorpus(deps);
      const result = await recallSearch(deps, params("zxqvbm wkxqjy", ["zxqvbm"]));
      expect(result.searchSkipped).toBeUndefined();
      expect(result.stageOutcomes?.["Sf"]?.status).toBe("completed");
    } finally {
      deps.db.close();
    }
  });

  it("a corpus below five rows never skips", async () => {
    const deps = setupDb();
    try {
      insert(deps, 1, "daily routine note", "köszi szépen");
      insert(deps, 2, "daily routine note again", "köszi szépen megint");
      const result = await recallSearch(deps, params("köszi", ["note"]));
      expect(result.searchSkipped).toBeUndefined();
    } finally {
      deps.db.close();
    }
  });

  it("invalid intent searches instead of skipping", async () => {
    const deps = setupDb();
    try {
      seedBilingualCourtesyCorpus(deps);
      const result = await recallSearch(
        deps,
        // Invalid supplied intent is a caller bug: conservative search.
        params("köszi", ["note"], { intent: "bogus" as unknown as RecallIntent }),
      );
      expect(result.searchSkipped).toBeUndefined();
      expect(result.stageOutcomes?.["Sf"]?.status).toBe("completed");
    } finally {
      deps.db.close();
    }
  });

  it("an English df failure followed by a dense source index still searches", async () => {
    const deps = setupDb();
    try {
      seedBilingualCourtesyCorpus(deps);
      // Break the English porter measure; the dense source index must not
      // rescue the skip through the error-to-zero fallback.
      deps.db.exec("DROP TABLE extracted_memories_fts");
      expect(measureEnglishDf(deps.db, "1=1", [], "köszi").ok).toBe(false);
      expect(measureSourceTokenDf(deps.db, "1=1", [], "köszi").df).toBeGreaterThan(0);
      const result = await recallSearch(deps, params("köszi", ["note"]));
      expect(result.searchSkipped).toBeUndefined();
    } finally {
      deps.db.close();
    }
  });

  it("a ninth distinct topical token following eight common tokens searches", async () => {
    const deps = setupDb();
    try {
      const common = ["köszi", "üdv", "szia", "helló", "köszönet", "üdvözlet", "viszlát", "pápá"];
      for (let i = 1; i <= 12; i++) {
        insert(deps, i, `daily routine note number ${i}`, `${common.join(" ")} ${i}`);
      }
      insert(deps, 13, "migration owns the staging rollback", "migráciosterv az élesítéshez");
      // Control: the eight common tokens alone skip.
      const control = await recallSearch(deps, params(common.join(" "), ["note"]));
      expect(skipResult(control.searchSkipped)).toBe(true);
      // The ninth distinct candidate is detected without further df queries.
      const result = await recallSearch(deps, params([...common, "migráciosterv"].join(" "), ["migration"]));
      expect(result.searchSkipped).toBeUndefined();
      expect(result.results.map((h) => h.id)).toContain(13);
    } finally {
      deps.db.close();
    }
  });

  it("an unmeasurable short token alongside common tokens cannot justify a skip", async () => {
    const deps = setupDb();
    try {
      seedBilingualCourtesyCorpus(deps);
      const result = await recallSearch(deps, params("köszi a migráció", ["migration"]));
      expect(result.searchSkipped).toBeUndefined();
    } finally {
      deps.db.close();
    }
  });

  it("a typo variant still reaches retrieval and returns its seeded memory", async () => {
    const deps = setupDb();
    try {
      seedBilingualCourtesyCorpus(deps);
      // `migraton` is unseen (no df evidence) so the turn searches; the
      // trigram rescue still finds the seeded migration memory.
      const result = await recallSearch(deps, params("migraton terv", ["migraton"]));
      expect(result.searchSkipped).toBeUndefined();
      expect(result.results.map((h) => h.id)).toContain(1);
    } finally {
      deps.db.close();
    }
  });
});

describe("#1895 — index and scope safety", () => {
  it("mid-token source collisions cannot count as common query tokens", async () => {
    const deps = setupDb();
    try {
      // `dog` occurs only inside `watchdog` in every eligible original.
      for (let i = 1; i <= 12; i++) {
        insert(deps, i, `daily routine note number ${i}`, `a watchdog fut az udvaron ${i}`);
      }
      const source = measureSourceTokenDf(deps.db, "1=1", [], "dog");
      expect(source.ok).toBe(true);
      expect(source.df).toBe(0);
      const result = await recallSearch(deps, params("dog", ["dog"]));
      expect(result.searchSkipped).toBeUndefined();
    } finally {
      deps.db.close();
    }
  });

  it("expired rows do not affect the verdict", async () => {
    const deps = setupDb();
    try {
      const past = new Date(Date.now() - 1000).toISOString();
      for (let i = 1; i <= 12; i++) {
        insert(deps, i, `daily routine note number ${i}`, `köszi szépen ${i}`, { validTo: past });
      }
      for (let i = 13; i <= 18; i++) {
        insert(deps, i, `fresh topical note number ${i}`, `friss tartalom ${i}`);
      }
      // Default scope: the courtesy token is unseen in eligible rows.
      const searching = await recallSearch(deps, params("köszi", ["note"]));
      expect(searching.searchSkipped).toBeUndefined();
      // The same corpus with expiry ignored would skip — the filter decides.
      const verdict = classifyRawTurn(
        deps.db,
        { translated: ["note"], userId: USER, limit: 10, maxClassification: 2, includeExpired: true },
        "köszi",
      );
      expect(verdict.skip).toBe(true);
    } finally {
      deps.db.close();
    }
  });

  it("invisible rows do not affect the verdict", async () => {
    const deps = setupDb();
    try {
      // Class-2 rows are owner-only: invisible to user-123.
      for (let i = 1; i <= 12; i++) {
        insert(deps, i, `daily routine note number ${i}`, `köszi szépen ${i}`, { userId: "other-user", classification: 2 });
      }
      for (let i = 13; i <= 18; i++) {
        insert(deps, i, `fresh topical note number ${i}`, `friss tartalom ${i}`);
      }
      const searching = await recallSearch(deps, params("köszi", ["note"]));
      expect(searching.searchSkipped).toBeUndefined();
      // Visible to the other principal, the same corpus would skip.
      const verdict = classifyRawTurn(
        deps.db,
        { translated: ["note"], userId: "other-user", limit: 10, maxClassification: 2 },
        "köszi",
      );
      expect(verdict.skip).toBe(true);
    } finally {
      deps.db.close();
    }
  });
});
