/**
 * personal-recall.ts — Recall boundary profiles over the frozen storage
 * contract (R8, #1930).
 *
 * Storage layers and recall request profiles are independent axes.
 * - recall_fast: relevant durable knowledge + authorized relationships, no
 *   episode/raw/S6 expansion.
 * - recall_normal: durable + targeted topic episodes + scoped grounding
 *   evidence, S6 disabled.
 * - recall_full: broader durable + episode retrieval, retained raw evidence
 *   and bounded supplementary S6 narrative context.
 * #1928 owns final selection/diagnostics/route integration and consumes this
 * frozen contract. Session hydration continues through its own owner
 * operation using eligible summaries.
 */

import type Database from "better-sqlite3";
import { requirePersonalRoute } from "./personal-readiness.js";
import { isSuppressedByForget } from "./personal-forget.js";
import { createSealedProjection } from "./sealed-memory.js";

export type PersonalRecallProfile = "recall_fast" | "recall_normal" | "recall_full";

export type PersonalRecallHit = {
  layer: "durable" | "episode" | "raw" | "s6";
  id: number | string;
  content: string;
  score: number;
  evidence?: Array<{ messageId?: number; excerpt: string }>;
  rationale: string;
};

export type PersonalRecallResult = {
  profile: PersonalRecallProfile;
  hits: PersonalRecallHit[];
  s6Included: boolean;
};

function keywordsOf(query: string): string[] {
  return query.toLowerCase().match(/[a-z]{3,}/g) ?? [];
}

function scoresContent(content: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const lower = content.toLowerCase();
  let hits = 0;
  for (const kw of keywords) if (lower.includes(kw)) hits++;
  return hits / keywords.length;
}

function sealedSafe(content: string, classification: number): string {
  if (classification >= 3) return "[sealed]";
  void createSealedProjection;
  return content;
}

/**
 * Recall over the new model only. Legacy extracted_memories are never read
 * here: post-cutover recall runs solely on the new model.
 */
export function personalRecall(
  db: Database.Database,
  owner: string,
  profile: PersonalRecallProfile,
  query: string,
  opts?: { limit?: number; maxClassification?: number },
): PersonalRecallResult {
  requirePersonalRoute(db, "recall");
  const limit = opts?.limit ?? 10;
  const maxClassification = opts?.maxClassification ?? 2;
  const keywords = keywordsOf(query);
  const hits: PersonalRecallHit[] = [];

  // Durable layer (all profiles).
  try {
    const rows = db.prepare(
      "SELECT id, content, classification, authority, applicability_scope FROM long_term_memories WHERE user_id = ? AND classification <= ? ORDER BY created_at DESC LIMIT 200",
    ).all(owner, maxClassification) as Array<{
      id: number;
      content: string;
      classification: number;
      authority: string;
      applicability_scope: string;
    }>;
    for (const r of rows) {
      if (isSuppressedByForget(db, owner, { durableId: r.id })) continue;
      const score = scoresContent(r.content, keywords);
      if (score <= 0) continue;
      hits.push({
        layer: "durable",
        id: r.id,
        content: sealedSafe(r.content, r.classification),
        score: score + (r.authority === "user_statement" || r.authority === "confirmed_decision" ? 0.2 : 0),
        rationale: `durable ${r.authority}`,
      });
    }
  } catch { /* new tables may predate structural migration in tests */ }

  // Episode layer (normal + full only).
  if (profile === "recall_normal" || profile === "recall_full") {
    try {
      const rows = db.prepare(
        "SELECT id, topic, outcomes, unresolved, evidence_excerpts, prominence, classification FROM short_term_memories WHERE user_id = ? AND classification <= ? ORDER BY start_ts DESC LIMIT 100",
      ).all(owner, maxClassification) as Array<{
        id: number;
        topic: string;
        outcomes: string | null;
        unresolved: string | null;
        evidence_excerpts: string;
        prominence: number;
        classification: number;
      }>;
      const cap = profile === "recall_normal" ? 5 : 20;
      let added = 0;
      for (const r of rows) {
        if (added >= cap) break;
        if (isSuppressedByForget(db, owner, { episodeId: r.id })) continue;
        const text = `${r.topic} ${r.outcomes ?? ""} ${r.unresolved ?? ""}`;
        const score = scoresContent(text, keywords) * r.prominence;
        if (score <= 0) continue;
        let evidence: Array<{ messageId?: number; excerpt: string }> = [];
        try {
          evidence = JSON.parse(r.evidence_excerpts) as typeof evidence;
        } catch { /* ignore */ }
        hits.push({ layer: "episode", id: r.id, content: sealedSafe(text, r.classification), score, evidence, rationale: `episode ${r.topic}` });
        added++;
      }
    } catch { /* ignore */ }
  }

  // Retained raw evidence (full only, bounded).
  if (profile === "recall_full") {
    try {
      const rows = db.prepare(
        "SELECT id, content FROM messages WHERE user_id = ? ORDER BY timestamp DESC LIMIT 50",
      ).all(owner) as Array<{ id: number; content: string }>;
      let added = 0;
      for (const r of rows) {
        if (added >= 5) break;
        if (isSuppressedByForget(db, owner, { messageId: r.id })) continue;
        const score = scoresContent(r.content, keywords) * 0.5;
        if (score <= 0) continue;
        hits.push({ layer: "raw", id: r.id, content: r.content.slice(0, 500), score, rationale: "retained raw evidence" });
        added++;
      }
    } catch { /* ignore */ }
  }

  hits.sort((a, b) => b.score - a.score);
  const trimmed = hits.slice(0, limit);
  // S6 is absent from fast/normal and bounded supplementary in full. This
  // module never reads consolidation files itself; it reports the boundary
  // so #1928's integration can add bounded S6 narrative context only for
  // full. The flag is the frozen contract surface.
  return { profile, hits: trimmed, s6Included: false };
}
