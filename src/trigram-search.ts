/**
 * trigram-search.ts — Sf stage: three-query fuzzy search.
 *
 * 1. Porter FTS5 on content_en (stemmed keyword match)
 * 2. Trigram on content_en + preserved_keyword (fuzzy/typo/substring, diacritics-stripped)
 * 3. If results < limit: trigram on content_original (Hungarian fallback, diacritics-stripped)
 */

import type Database from "better-sqlite3";
import { localISO } from "./local-time.js";
import type { RecallHit } from "./recall-engine.js";

export type SfOptions = {
  translated: string[];
  original?: string;
  userId: string;
  limit: number;
  maxClassification: number;
  timeStart?: number;
  timeEnd?: number;
  topic?: string;
  tier?: string;
  emotion?: string;
  includeExpired?: boolean;
  resolution?: string;
};

type MemRow = {
  id: number;
  content_en: string | null;
  content_original: string | null;
  memory_type: string | null;
  created_at: number;
  source_message_ids: string | null;
  trust: number | null;
  integrity: number | null;
  credibility: number | null;
  classification: number | null;
  recall_count: number;
  relevance_score: number;
  preserved_keyword: string | null;
};

/** Strip diacritics (mirrors the SQLite function). */
function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Generate substring queries for fuzzy matching when full word fails.
 *  Splits word into overlapping windows of ~half length (min 4 chars). */
function substrings(word: string, minLen = 4): string[] {
  if (word.length <= minLen + 2) return [];
  const windowLen = Math.max(Math.floor(word.length / 2), minLen);
  const subs: string[] = [];
  for (let i = 0; i <= word.length - windowLen; i += Math.max(1, Math.floor(windowLen / 2))) {
    subs.push(word.slice(i, i + windowLen));
  }
  return subs;
}

/** QWERTZ↔QWERTY z/y swap variant. */
const ZY_SWAP: Record<string, string> = { z: "y", y: "z" };
function zyVariant(word: string): string {
  const swapped = [...word].map(c => ZY_SWAP[c] ?? c).join("");
  return swapped === word ? "" : swapped;
}

function trigramQuery(
  db: Database.Database, table: string, keyword: string,
  where: string, params: (string | number)[], fetchLimit: number,
  addRow: (row: MemRow, source: string) => void, source: string,
): void {
  const stripped = stripDiacritics(keyword);
  if (stripped.length < 3) return;
  try {
    const rows = db.prepare(
      `SELECT ${MEM_COLS} FROM ${table} ft
       JOIN extracted_memories em ON ft.rowid = em.id
       WHERE ${table} MATCH ? AND ${where}
       ORDER BY rank LIMIT ?`,
    ).all(`"${stripped}"`, ...params, fetchLimit) as MemRow[];
    for (const r of rows) addRow(r, source);
    if (rows.length > 0) return;

    // Fallback 1: z↔y swap (QWERTZ keyboard)
    const zy = zyVariant(stripped);
    if (zy) {
      const zyRows = db.prepare(
        `SELECT ${MEM_COLS} FROM ${table} ft
         JOIN extracted_memories em ON ft.rowid = em.id
         WHERE ${table} MATCH ? AND ${where}
         ORDER BY rank LIMIT ?`,
      ).all(`"${zy}"`, ...params, fetchLimit) as MemRow[];
      for (const r of zyRows) addRow(r, source);
      if (zyRows.length > 0) return;
    }

    // Fallback 2: substring windows for typo tolerance
    for (const sub of substrings(stripped)) {
      try {
        const subRows = db.prepare(
          `SELECT ${MEM_COLS} FROM ${table} ft
           JOIN extracted_memories em ON ft.rowid = em.id
           WHERE ${table} MATCH ? AND ${where}
           ORDER BY rank LIMIT ?`,
        ).all(`"${sub}"`, ...params, fetchLimit) as MemRow[];
        for (const r of subRows) addRow(r, source);
      } catch { /* */ }
    }
  } catch { /* trigram query error */ }
}

const EMOTION_GROUPS: Record<string, string[]> = {
  positive: ["joy", "pride", "excitement", "relief", "gratitude", "love", "hope", "humor"],
  negative: ["frustration", "anger", "fear", "grief", "anxiety", "exhaustion", "doubt"],
  "high-energy": ["excitement", "anger", "determination", "surprise"],
};

function expandEmotionFilter(emotion: string): string[] {
  return EMOTION_GROUPS[emotion] ?? emotion.split(",").map(s => s.trim()).filter(Boolean);
}

function buildWhereClause(opts: SfOptions): { where: string; params: (string | number)[] } {
  const conditions: string[] = ["1=1"];
  const params: (string | number)[] = [];
  if (opts.maxClassification !== undefined) { conditions.push("COALESCE(em.classification, 0) <= ?"); params.push(opts.maxClassification); }
  // Privacy: class 0-1 shared, class 2+ private to owner
  if (opts.userId) { conditions.push("(COALESCE(em.classification, 0) <= 1 OR em.user_id = ?)"); params.push(opts.userId); }
  if (opts.timeStart) { conditions.push("em.created_at >= ?"); params.push(opts.timeStart); }
  if (opts.timeEnd) { conditions.push("em.created_at <= ?"); params.push(opts.timeEnd); }
  if (opts.topic) { conditions.push("em.topic = ?"); params.push(opts.topic); }
  if (opts.tier) { conditions.push("em.tier = ?"); params.push(opts.tier); }
  if (!opts.includeExpired) { conditions.push("em.valid_to IS NULL"); }
  if (opts.emotion) {
    const tags = expandEmotionFilter(opts.emotion);
    conditions.push(`(${tags.map(t => { params.push(`%${t}%`); return "em.emotion_tags LIKE ?"; }).join(" OR ")})`);
  }
  return { where: conditions.join(" AND "), params };
}

function darwinismScore(row: MemRow): number {
  const base = 0.95;
  const recallBoost = Math.min(row.recall_count * 0.02, 0.2);
  const relevanceBoost = Math.min((row.relevance_score ?? 0) * 0.01, 0.1);
  return base + recallBoost + relevanceBoost;
}

function rowToHit(row: MemRow, source: string): RecallHit {
  return {
    id: row.id,
    content: row.content_en ?? "",
    date: localISO(new Date(row.created_at)),
    source,
    score: darwinismScore(row),
    ...(row.source_message_ids ? { source_ids: row.source_message_ids } : {}),
    contentOriginal: row.content_original ?? undefined,
    memoryType: row.memory_type ?? undefined,
    trust: row.trust ?? undefined,
    integrity: row.integrity ?? undefined,
    credibility: row.credibility ?? undefined,
    classification: row.classification ?? undefined,
  };
}

const MEM_COLS = `em.id, em.content_en, em.content_original, em.memory_type, em.created_at,
  em.source_message_ids, em.trust, em.integrity, em.credibility, em.classification,
  em.recall_count, COALESCE(em.relevance_score, 0) as relevance_score, em.preserved_keyword`;

export function trigramSearch(db: Database.Database, opts: SfOptions): { hits: RecallHit[]; extractedIds: number[] } {
  const seen = new Set<number>();
  const hits: RecallHit[] = [];
  const extractedIds: number[] = [];
  const { where, params } = buildWhereClause(opts);
  const fetchLimit = opts.limit * 3;

  const addRow = (row: MemRow, source: string): void => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    extractedIds.push(row.id);
    hits.push(rowToHit(row, source));
  };

  // Sf.1: Porter FTS5 on content_en (existing index)
  const query = opts.translated.join(" ");
  if (query.trim()) {
    try {
      const ftsQuery = opts.translated.map(kw => `"${kw.replace(/"/g, "")}"`).join(" OR ");
      const rows = db.prepare(
        `SELECT ${MEM_COLS} FROM extracted_memories_fts ft
         JOIN extracted_memories em ON ft.rowid = em.id
         WHERE extracted_memories_fts MATCH ? AND ${where}
         ORDER BY rank LIMIT ?`,
      ).all(ftsQuery, ...params, fetchLimit) as MemRow[];
      for (const r of rows) addRow(r, "Sf:porter");
    } catch { /* FTS5 query error */ }
  }

  // Sf.2: Trigram on content_en + preserved_keyword (diacritics-stripped)
  if (hits.length < opts.limit) {
    const allKw = [...opts.translated];
    if (opts.original) allKw.push(opts.original);
    for (const kw of allKw) {
      if (hits.length >= opts.limit) break;
      trigramQuery(db, "content_en_trigram", kw, where, params, fetchLimit, addRow, "Sf:trigram_en");
    }
  }

  // Sf.3: Trigram on content_original (Hungarian fallback, only if results < limit)
  if (hits.length < opts.limit) {
    const allKw = [...opts.translated];
    if (opts.original) allKw.push(opts.original);
    for (const kw of allKw) {
      if (hits.length >= opts.limit) break;
      trigramQuery(db, "content_original_trigram", kw, where, params, fetchLimit, addRow, "Sf:trigram_orig");
    }
  }

  return { hits, extractedIds };
}
