/**
 * recall-boosts.ts — Context, spacing, emotion, and quality boost helpers for the recall pipeline.
 * Extracted from recall-engine.ts (#1229).
 * Uses `import type` for RecallHit/RecallContext to avoid a runtime circular dependency
 * (recall-engine.ts imports these functions; this module imports the types from recall-engine.ts).
 */

import type Database from "better-sqlite3";
import { logDebug } from "./mem-logger.js";
import type { RecallHit, RecallContext } from "./recall-engine.js";

const TAG = "recall";

const DAY_MS = 86400000;

// ── Context boost weights (env-tunable) ─────────────────────────────────────

const CTX_HOUR_BOOST = parseFloat(process.env.RECALL_CONTEXT_HOUR_BOOST ?? "0.02");
const CTX_DOW_BOOST = parseFloat(process.env.RECALL_CONTEXT_DOW_BOOST ?? "0.015");
const CTX_TOPIC_BOOST = parseFloat(process.env.RECALL_CONTEXT_TOPIC_BOOST ?? "0.03");

function hourBucket(hour: number): number {
  if (hour >= 6 && hour < 12) return 0;  // morning
  if (hour >= 12 && hour < 18) return 1; // afternoon
  if (hour >= 18 && hour < 23) return 2; // evening
  return 3; // night
}

function isWeekend(dow: number): boolean { return dow === 0 || dow === 6; }

export function applyContextBoost(results: RecallHit[], ctx: RecallContext): RecallHit[] {
  if (!ctx.hour && ctx.hour !== 0 && !ctx.dayOfWeek && ctx.dayOfWeek !== 0 && !ctx.topic) return results;

  let boostedCount = 0;
  const boosted = results.map(hit => {
    let boost = 0;
    const ts = hit.createdAt;
    if (ts && (ctx.hour != null || ctx.dayOfWeek != null)) {
      const d = new Date(ts);
      if (ctx.hour != null && hourBucket(d.getHours()) === hourBucket(ctx.hour)) {
        boost += CTX_HOUR_BOOST;
      }
      if (ctx.dayOfWeek != null) {
        const storedDow = d.getDay();
        if (storedDow === ctx.dayOfWeek) boost += CTX_DOW_BOOST;
        else if (isWeekend(storedDow) === isWeekend(ctx.dayOfWeek)) boost += CTX_DOW_BOOST * 0.5;
      }
    }
    if (ctx.topic && hit.topic && hit.topic !== "general" && hit.topic === ctx.topic) {
      boost += CTX_TOPIC_BOOST;
    }
    if (boost > 0) boostedCount++;
    return boost > 0 ? { ...hit, score: hit.score + boost } : hit;
  });

  if (boostedCount > 0) {
    logDebug(TAG, `context-boost applied to ${boostedCount}/${results.length} candidates`);
  }
  return boosted;
}

// ── Spacing boost (#244) ────────────────────────────────────────────────────

function spacingBoost(timestamps: number[]): number {
  if (timestamps.length < 2) return 1.0;
  const intervals: number[] = [];
  for (let i = 1; i < timestamps.length; i++) intervals.push(timestamps[i]! - timestamps[i - 1]!);
  const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  if (avg >= 7 * DAY_MS) return 1.3;
  if (avg >= 1 * DAY_MS) return 1.15;
  return 1.0;
}

export function applySpacingBoost(results: RecallHit[], db: Database.Database): RecallHit[] {
  if (results.length === 0) return results;
  const ids = results.filter(r => r.id != null).map(r => r.id!);
  if (ids.length === 0) return results;
  const ph = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT id, recall_timestamps FROM extracted_memories WHERE id IN (${ph})`).all(...ids) as Array<{ id: number; recall_timestamps: string | null }>;
  const tsMap = new Map(rows.map(r => [r.id, JSON.parse(r.recall_timestamps ?? "[]") as number[]]));
  return results.map(hit => {
    if (!hit.id) return hit;
    const ts = tsMap.get(hit.id);
    if (!ts || ts.length < 2) return hit;
    const mult = spacingBoost(ts);
    return mult > 1.0 ? { ...hit, score: hit.score * mult } : hit;
  });
}

// ── Emotion boost (#404) ────────────────────────────────────────────────────
//
// Tie-breaker-only boost for emotionally charged memories. Linear: |e| * 0.02,
// max +0.10 at |e|=5. Intentionally small — recall-engine scores are in the
// 0.4-1.2 range (darwinism ~0.95-1.25, cosine ~0-1, hamming ~0-1, hardcoded
// 0.5/0.6), so +0.10 is ~10% — enough to break ties, not enough to override a
// relevance gap of 0.2+.
//
// NOT the same weight as memory-index.ts EMOTION_BOOST_WEIGHT (0.5 * log(1+|e|)).
// That path operates on BM25 scores (5-20+), where +0.9 is proportionate.
// Different score regime, different weight — same direction (boost), same
// concept (emotional salience as tie-breaker). Each path applies the boost
// exactly once. Do NOT sum results across the two paths.

/** Recall-engine emotion boost multiplier: |emotion_score| * this = additive boost. */
export const RECALL_EMOTION_MULT = 0.02;

export function applyEmotionBoost(results: RecallHit[], db: Database.Database): RecallHit[] {
  if (results.length === 0) return results;
  const ids = results.filter(r => r.id != null).map(r => r.id!);
  if (ids.length === 0) return results;
  const ph = ids.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, emotion_score FROM extracted_memories WHERE id IN (${ph})`,
  ).all(...ids) as Array<{ id: number; emotion_score: number | null }>;
  const emMap = new Map(rows.map(r => [r.id, r.emotion_score]));
  return results.map(hit => {
    if (hit.id == null) return hit;
    const e = emMap.get(hit.id);
    if (e == null || e === 0) return hit;
    const boost = Math.abs(e) * RECALL_EMOTION_MULT;
    return { ...hit, score: hit.score + boost, emotionScore: e };
  });
}

// ── Quality boost (#824) ────────────────────────────────────────────────────
//
// Citation/rejection signal: memories the agent actually used get boosted,
// memories the user rejected get penalized. Uses (cited - rejected) / surfaced.
// Also applies ×0.85 penalty for memories recalled 5+ times in last 30d with 0 citations.

export function applyQualityBoost(results: RecallHit[], db: Database.Database): RecallHit[] {
  if (results.length === 0) return results;
  const ids = results.filter(r => r.id != null).map(r => r.id!);
  if (ids.length === 0) return results;
  const ph = ids.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, recall_count, cited_count, rejected_count, recall_timestamps FROM extracted_memories WHERE id IN (${ph})`,
  ).all(...ids) as Array<{ id: number; recall_count: number; cited_count: number; rejected_count: number; recall_timestamps: string | null }>;
  const qMap = new Map(rows.map(r => [r.id, r]));

  const now = Date.now();
  const thirtyDays = 30 * DAY_MS;

  return results.map(hit => {
    if (hit.id == null) return hit;
    const row = qMap.get(hit.id);
    if (!row || row.recall_count === 0) return hit;

    // Quality score: (cited - rejected) / recall_count, clamped to [-0.10, +0.15]
    const qualityScore = (row.cited_count - row.rejected_count) / Math.max(row.recall_count, 1);
    const boost = Math.max(-0.10, Math.min(0.15, qualityScore * 0.15));

    // Penalty: 5+ recent recalls with 0 citations → ×0.85
    let penalty = 1.0;
    if (row.cited_count === 0 && row.recall_count >= 5) {
      const timestamps: number[] = JSON.parse(row.recall_timestamps ?? "[]");
      const recentRecalls = timestamps.filter(t => (now - t) < thirtyDays).length;
      if (recentRecalls >= 5) penalty = 0.85;
    }

    return { ...hit, score: (hit.score + boost) * penalty };
  });
}
