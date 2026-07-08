/**
 * fts-utils.ts — FTS5 query sanitization, row scoring, and recency/emotion helpers.
 * Extracted from memory-index.ts (#1229).
 */

import { getAbmindEnv } from "./env-schema.js";
import type { MemorySearchResult } from "./mem-types.js";

/** Weight applied to the log1p emotion boost in search ranking. */
export const EMOTION_BOOST_WEIGHT = 0.5;

// Time-decay: recent memories score higher, emotional ones resist decay

/** Compute recency factor with emotion override. */
export function recencyFactor(createdAt: number, emotionScore: number): number {
  const ageDays = (Date.now() - createdAt) / (24 * 3600000);
  const decay = Math.max(getAbmindEnv().recallDecayFloor, 1 - ageDays / getAbmindEnv().recallDecayDays);
  const emotionBoost = 1 + Math.abs(emotionScore) * getAbmindEnv().recallEmotionBoost;
  return decay * emotionBoost;
}

/** Strip diacritical marks (accents) from a string using Unicode NFD decomposition. */
export function stripAccents(str: string): string {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Sanitize a raw query string for safe use in an FTS5 MATCH clause.
 *
 * Wraps each whitespace-delimited token in double quotes (stripping any
 * internal quotes) with a trailing `*` for prefix matching. Quoting
 * neutralizes all FTS5 operators (OR, NOT, NEAR, ^, *, :, -, etc.)
 * without needing a blacklist. Prefix matching is critical for
 * agglutinative languages (e.g. Hungarian) where "jelszó" needs to
 * match "jelszóra", "jelszót", etc.
 * Returns empty string if no valid tokens remain.
 */
export function sanitizeFtsQuery(query: string, mode: "or" | "and" = "and"): string {
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  const joiner = mode === "or" ? " OR " : " ";
  return tokens.map((t) => `"${t.replace(/"/g, "")}"*`).join(joiner);
}

/** Row shape returned by extracted memory FTS queries. */
export type ExtractedFtsRow = {
  id: number; content_en: string; content_original: string; memory_type: string;
  created_at: number; preserve_original: number; emotion_score: number;
  recall_count: number; relevance_score: number; source_message_ids: string | null;
  trust: number | null; integrity: number | null; credibility: number | null;
  classification: number | null; rank: number; tier: string | null;
};

/** Compute final score for an extracted memory FTS row. */
export function scoreExtractedRow(row: ExtractedFtsRow, baseScore: number): number {
  const emotionBoost = EMOTION_BOOST_WEIGHT * Math.log(1 + Math.abs(row.emotion_score));
  const recallBoost = 0.1 * (row.recall_count ?? 0);
  const relevanceBoost = (row.relevance_score ?? 0) > 0 ? 0.2 : 0;
  const trustFactor = 0.5 + 0.5 * (row.trust ?? 0) / 3;
  const credibilityFactor = (row.credibility !== null && row.credibility <= 2) ? 1.25 : 1;
  const tierBoost = row.tier === "core" ? 1.3 : 1;
  return (baseScore + emotionBoost) * (1 + recallBoost) * (1 + relevanceBoost) * trustFactor * credibilityFactor * tierBoost * recencyFactor(row.created_at, row.emotion_score);
}

/** Map an extracted memory FTS row to a MemorySearchResult. */
export function mapExtractedRow(row: ExtractedFtsRow, score: number): MemorySearchResult {
  return {
    id: row.id,
    content: row.content_en,
    content_original: row.content_original,
    memory_type: row.memory_type,
    created_at: row.created_at,
    source_message_ids: row.source_message_ids ?? undefined,
    trust: row.trust ?? 0,
    integrity: row.integrity ?? 2,
    credibility: row.credibility ?? 6,
    classification: row.classification ?? 1,
    tier: "extracted" as const,
    score,
  };
}
