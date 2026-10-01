/**
 * #1894 — cheap worth-retrieving check over the raw turn.
 *
 * Same verdict as the full recall skip for the same turn, intent, and
 * effective filters, without running any stage, embedding, System One, or
 * LLM call. The check takes only the database: it structurally cannot reach
 * a provider. Fixtures reuse the #1895 production bilingual shape (English
 * `content_en` plus distinct Hungarian `content_original`).
 */
import { describe, it, expect } from "vitest";
import { recallSearch, checkWorthRetrieving, type RecallDeps, type RecallParams } from "./recall-engine.js";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";

const USER = "user-123";

function setupDeps(): RecallDeps {
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

/**
 * Two rare topical memories plus twelve courtesy memories whose source
 * token `köszi` is common in eligible originals. Ceiling is
 * max(2, floor(14 * 0.25)) = 3; courtesy df is 12.
 */
function seedBilingualCourtesyCorpus(deps: RecallDeps): void {
  insert(deps, 1, "migration owns the staging rollback procedure", "a migráció kezeli az élesítési visszagörgetést");
  insert(deps, 2, "migration runs the nightly data reload", "a migráció futtatja az éjszakai adatbetöltést");
  for (let i = 3; i <= 14; i++) {
    insert(deps, i, `daily routine note number ${i}`, `köszi szépen a napi rutinhoz ${i}`);
  }
}

function skipped(result: { searchSkipped?: unknown }): boolean {
  return result.searchSkipped === true;
}

describe("#1894 — check verdicts", () => {
  it("skips a source-courtesy turn with corpus diagnostics", () => {
    const deps = setupDeps();
    try {
      seedBilingualCourtesyCorpus(deps);
      const verdict = checkWorthRetrieving(deps.db, { original: "köszi", userId: USER });
      expect(verdict.verdict).toBe("skip");
      expect(verdict.corpusSize).toBe(14);
      expect(verdict.ceiling).toBe(3);
    } finally {
      deps.db.close();
    }
  });

  it("skips an English courtesy turn common in content_en", () => {
    const deps = setupDeps();
    try {
      seedBilingualCourtesyCorpus(deps);
      const verdict = checkWorthRetrieving(deps.db, { original: "note routine daily", userId: USER });
      expect(verdict.verdict).toBe("skip");
    } finally {
      deps.db.close();
    }
  });

  it("searches a turn carrying a rare topical token", () => {
    const deps = setupDeps();
    try {
      seedBilingualCourtesyCorpus(deps);
      const verdict = checkWorthRetrieving(deps.db, { original: "köszi migrációs terv", userId: USER });
      expect(verdict.verdict).toBe("search");
    } finally {
      deps.db.close();
    }
  });

  it("explicit intent searches without measuring", () => {
    const deps = setupDeps();
    try {
      seedBilingualCourtesyCorpus(deps);
      const verdict = checkWorthRetrieving(deps.db, { original: "köszi", userId: USER, intent: "explicit" });
      expect(verdict).toEqual({ verdict: "search", corpusSize: 0, ceiling: 0 });
    } finally {
      deps.db.close();
    }
  });

  it("invalid intent searches without measuring", () => {
    const deps = setupDeps();
    try {
      seedBilingualCourtesyCorpus(deps);
      const verdict = checkWorthRetrieving(deps.db, {
        original: "köszi", userId: USER, intent: "nope" as never,
      });
      expect(verdict).toEqual({ verdict: "search", corpusSize: 0, ceiling: 0 });
    } finally {
      deps.db.close();
    }
  });

  it("missing original searches", () => {
    const deps = setupDeps();
    try {
      seedBilingualCourtesyCorpus(deps);
      expect(checkWorthRetrieving(deps.db, { userId: USER }).verdict).toBe("search");
      expect(checkWorthRetrieving(deps.db, { original: "  ", userId: USER }).verdict).toBe("search");
    } finally {
      deps.db.close();
    }
  });

  it("sub-5-row corpus searches", () => {
    const deps = setupDeps();
    try {
      insert(deps, 1, "daily routine note", "köszi szépen");
      insert(deps, 2, "daily routine note two", "köszi szépen újra");
      const verdict = checkWorthRetrieving(deps.db, { original: "köszi", userId: USER });
      expect(verdict.verdict).toBe("search");
    } finally {
      deps.db.close();
    }
  });
});

describe("#1894 — check/recall agreement", () => {
  const turns = [
    "köszi",
    "köszi szépen",
    "note routine daily",
    "köszi migrációs terv",
    "migrációs visszagörgetés",
    "migration rollback",
    "xyznothingmatches",
    "köszi OR migráció",
  ];

  it.each(turns)("turn %p: check and full recall agree", async (turn) => {
    const deps = setupDeps();
    try {
      seedBilingualCourtesyCorpus(deps);
      const params: RecallParams = { translated: ["note"], original: turn, userId: USER, limit: 10, stages: ["Sf"] };
      const check = checkWorthRetrieving(deps.db, { original: turn, userId: USER, limit: 10 });
      const result = await recallSearch(deps, params);
      expect(check.verdict === "skip").toBe(skipped(result));
      if (check.verdict === "skip") {
        expect(result.searchSkippedReason).toBe("no-informative-terms");
      }
    } finally {
      deps.db.close();
    }
  });

  it("filter parity: an empty eligible scope searches on both", async () => {
    const deps = setupDeps();
    try {
      seedBilingualCourtesyCorpus(deps);
      // A future time window excludes every row: corpus 0 means search.
      const future = Date.now() + 60000;
      const check = checkWorthRetrieving(deps.db, { original: "köszi", userId: USER, timeStart: future });
      const result = await recallSearch(deps, {
        translated: ["note"], original: "köszi", userId: USER, limit: 10, stages: ["Sf"], timeStart: future,
      });
      expect(check.verdict).toBe("search");
      expect(skipped(result)).toBe(false);
    } finally {
      deps.db.close();
    }
  });
});
