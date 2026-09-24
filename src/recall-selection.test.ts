/**
 * #1813 — deterministic selection tests.
 *
 * Selection must be present and correct with NO provider, NO profile, NO
 * SYSTEM1_FASTPATH, and any backend (here: none configured). It is a pure
 * composition over the final ranked results plus an owner-side revision
 * verification, bounded by a payload budget.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import { recallSearch, SELECTION_BUDGET_BYTES, type RecallDeps, type RecallResult } from "./recall-engine.js";
import { initAbmindEnv, _resetAbmindEnv } from "./env-schema.js";

const ENV_KEYS = ["SYSTEM1", "SYSTEM1_FASTPATH", "SYSTEM1_RECALL"];

function row(db: Database.Database, id: number, contentEn: string, revision = 1): void {
  const now = Date.now();
  db.prepare(`INSERT INTO extracted_memories
    (id, content_en, content_original, memory_type, created_at, source_timestamp, user_id, confidence, emotion_score, recall_count, relevance_score, semantic_revision)
    VALUES (?, ?, ?, 'fact', ?, ?, 'user-123', 3, 0, 0, 0, ?)`).run(
    id, contentEn, contentEn, now, now, revision,
  );
}

function deps(db: Database.Database): RecallDeps {
  return { db, index: new MemoryIndex(db), memoryDir: "/tmp/test-memory" };
}

describe("#1813 — deterministic recall selection", () => {
  let saved: Record<string, string | undefined>;
  let db: Database.Database;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    _resetAbmindEnv();
    db = initializeDatabase(":memory:");
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

  async function recall(translated: string[]): Promise<RecallResult> {
    initAbmindEnv();
    return recallSearch(deps(db), { translated, userId: "user-123", limit: 10, stages: ["Sf"] });
  }

  it("is deterministic, rank-ordered, revision-verified, and needs no provider/flag", async () => {
    process.env["SYSTEM1"] = "off";
    row(db, 1, "Deploy production with the standard pipeline after CI passes.");
    row(db, 2, "Deploy rollbacks restore the previous production release.");
    row(db, 3, "Deploy credentials rotate on the first production Monday.", 7);

    const first = await recall(["deploy"]);
    expect(first.results.length).toBeGreaterThanOrEqual(2);
    const selection = first.selection;
    expect(selection).toBeDefined();
    expect(selection!.version).toBe(1);
    expect(selection!.budgetBytes).toBe(SELECTION_BUDGET_BYTES);

    // Refs are exactly the result order (a prefix/subsequence in rank order).
    const resultIds = first.results.filter((h) => typeof h.id === "number").map((h) => h.id);
    expect(selection!.refs.map((r) => r.id)).toEqual(
      resultIds.filter((id) => selection!.refs.some((r) => r.id === id)),
    );

    // Revisions come from verified rows, not from caller data.
    for (const ref of selection!.refs) {
      const dbRev = db.prepare("SELECT semantic_revision FROM extracted_memories WHERE id = ?").get(ref.id) as { semantic_revision: number };
      expect(ref.revision).toBe(dbRev.semantic_revision);
    }

    const second = await recall(["deploy"]);
    expect(second.selection).toEqual(selection);
  });

  it("keeps the whole verified set when it fits (truncated=false)", async () => {
    row(db, 1, "Deploy production safely.");
    row(db, 2, "Deploy staging first.");
    const res = await recall(["deploy"]);
    if (res.results.length * 40 < SELECTION_BUDGET_BYTES) {
      expect(res.selection!.truncated).toBe(false);
      expect(res.selection!.refs.length).toBe(res.results.filter((h) => typeof h.id === "number").length);
    }
  });

  it("skips an over-budget row so a smaller later row still fits", async () => {
    const huge = `Deploy ${"x".repeat(SELECTION_BUDGET_BYTES + 500)} deploy`;
    row(db, 1, huge);
    row(db, 2, "Deploy requires asking the operator before touching the database.");
    row(db, 3, "Deploy note.");

    const res = await recall(["deploy"]);
    const selection = res.selection!;
    expect(selection.refs.some((r) => r.id === 1)).toBe(false);
    expect(selection.refs.length).toBeGreaterThan(0);
    expect(selection.truncated).toBe(true);
    // Budget bounds the selected payload.
    const byId = new Map(res.results.map((h) => [h.id, h.content]));
    const selectedBytes = selection.refs.reduce((sum, r) => sum + Buffer.byteLength(byId.get(r.id) ?? "", "utf8"), 0);
    expect(selectedBytes).toBeLessThanOrEqual(SELECTION_BUDGET_BYTES);
    // The small constraint ranked after the huge row is still selected.
    expect(selection.refs.some((r) => r.id === 2)).toBe(true);
  });

  it("falls back to the top verified row when nothing fits the budget", async () => {
    row(db, 1, `Deploy ${"y".repeat(SELECTION_BUDGET_BYTES + 100)} deploy`);
    const res = await recall(["deploy"]);
    const selection = res.selection!;
    expect(selection.refs.length).toBe(1);
    expect(selection.refs[0]!.id).toBe(res.results.find((h) => typeof h.id === "number")!.id);
    expect(selection.truncated).toBe(true);
  });

  it("omits selection when no id-bearing results exist", async () => {
    row(db, 1, "Deploy production.");
    const res = await recall(["unrelated-term-nothing-matches"]);
    expect(res.results.length).toBe(0);
    expect(res.selection).toBeUndefined();
  });

  it("omits selection when revision verification fails", async () => {
    row(db, 1, "Deploy production.");
    const realPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string, ...rest: unknown[]) => {
      // Only the selection verification query has exactly this shape; stage
      // queries select wider column sets and must keep working.
      if (sql.startsWith("SELECT id, semantic_revision FROM")) throw new Error("database is locked");
      return (realPrepare as (...args: unknown[]) => unknown)(sql, ...rest) as never;
    }) as never);
    const res = await recall(["deploy"]);
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.selection).toBeUndefined();
  });
});
