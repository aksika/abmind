/**
 * #1913 Item 2 (R3) — explicit reaction adds measurable benefit.
 *
 * Calibration evidence for the shared-counter feedback mapping: with
 * distinct auto/explicit idempotency identities, automatic citation plus a
 * positive reaction (2 cites) scores above automatic citation alone (1 cite),
 * which scores above no feedback — for representative unsaturated histories.
 * Irrelevant memories (no shared history shape here) receive no boost path;
 * the mapping never exceeds its +0.15 positive bound.
 *
 * Recorded parameters (2026-10-05, current mapping): boost =
 * clamp((cited - rejected) / recall * 0.15, -0.10, +0.15). For recall_count 3:
 * none = +0.00, auto = +0.05, auto+explicit = +0.10. No mapping change was
 * needed to satisfy R3 once attribution gives the reaction its own event.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import { applyQualityBoost } from "./recall-boosts.js";
import type { RecallHit } from "./recall-engine.js";

function row(db: Database.Database, id: number, recallCount: number, cited: number, rejected = 0): void {
  const now = Date.now();
  db.prepare(`INSERT INTO extracted_memories
    (id, content_en, content_original, memory_type, created_at, source_timestamp, user_id, confidence, emotion_score, recall_count, cited_count, rejected_count, recall_timestamps, relevance_score, semantic_revision)
    VALUES (?, ?, ?, 'fact', ?, ?, 'user-123', 3, 0, ?, ?, ?, '[]', 0, 1)`).run(
    id, `Calibration memory ${id}`, `Calibration memory ${id}`, now, now, recallCount, cited, rejected,
  );
}

function hit(id: number): RecallHit {
  return { id, content: `Calibration memory ${id}`, date: "", source: "Sf:porter", score: 1.0 };
}

describe("#1913 R3 — explicit feedback benefit is measurable and bounded", () => {
  let db: Database.Database;

  beforeEach(() => { db = initializeDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  it("orders none < auto < auto+explicit on unsaturated histories", () => {
    row(db, 1, 3, 0);
    row(db, 2, 3, 1);
    row(db, 3, 3, 2);
    const boosted = applyQualityBoost([hit(1), hit(2), hit(3)], db);
    const score = new Map(boosted.map((h) => [h.id, h.score]));
    expect(score.get(2)).toBeGreaterThan(score.get(1)!);
    expect(score.get(3)).toBeGreaterThan(score.get(2)!);
    // Bounded: the strongest history stays within the +0.15 positive clamp.
    for (const s of score.values()) expect(s).toBeLessThanOrEqual(1.15);
  });

  it("keeps the negative bound for rejected histories", () => {
    row(db, 4, 3, 0, 3);
    const [out] = applyQualityBoost([hit(4)], db);
    expect(out!.score).toBeGreaterThanOrEqual(0.90);
    expect(out!.score).toBeLessThan(1.0);
  });
});
