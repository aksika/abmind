/**
 * trigram-search.ts — Sf stage: three-query fuzzy search.
 *
 * 1. Porter FTS5 on content_en (stemmed keyword match)
 * 2. Trigram on content_en + preserved_keyword (fuzzy/typo/substring, diacritics-stripped)
 * 3. Trigram on content_original (Hungarian fallback, diacritics-stripped)
 *
 * #1861 — the count-based probes are unconditional: a full porter pool no
 * longer suppresses the trigram probes, and the pool is ordered by how well
 * each candidate covers the supplied translated terms at a token boundary
 * (corpus document frequency weights rarer, more informative terms). Query
 * terms are consumed as supplied — translation, removal, and weighting of the
 * term source remain #1867's.
 *
 * #1836 — single-entry whole-message inputs take a bounded probe path instead:
 * full-phrase porter, one OR-of-words porter probe, then per-term trigram
 * rescue on both tables (runs even when the pool is not thin). The raw-message
 * probe order is preserved unchanged by #1861.
 */

import type Database from "better-sqlite3";
import { localISO } from "./local-time.js";
import type { RecallHit } from "./recall-engine.js";
import { logDebug, logTrace } from "./mem-logger.js";
import { redactSecrets } from "./redact-secrets.js";
import { sharedOrOwnedClause, effectiveMaxClassification } from "./memory-visibility.js";

const TAG = "recall";

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
  semantic_revision: number;
};

/** Strip diacritics (mirrors the SQLite function). */
function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const TOKEN_CHAR = /[\p{L}\p{N}]/u;

/**
 * #1861 — token-boundary match: the term must occur where a token starts.
 * `dog` matches `dog`, `dogs`, and `doghouse` (trailing characters are a
 * possible inflection) but not `watchdog` (a mid-token collision). Both cases
 * stay candidates; only the boundary match earns topical rank credit.
 */
export function hasTokenBoundaryMatch(content: string, term: string): boolean {
  if (term.length === 0) return false;
  const text = stripDiacritics(content);
  const needle = stripDiacritics(term);
  if (needle.length === 0) return false;
  for (let from = 0; ; ) {
    const at = text.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? undefined : text[at - 1];
    if (before === undefined || !TOKEN_CHAR.test(before)) return true;
    from = at + 1;
  }
}

// ── #1861 coverage ordering ─────────────────────────────────────────────────

type CoverageTerm = { readonly text: string; readonly weight: number };

/**
 * Corpus document frequency of a stemmed term inside the same eligible set
 * the probes search (visibility, expiry, and caller filters included), so the
 * measure never counts rows the caller cannot see.
 */
function termDocumentFrequency(
  db: Database.Database, where: string, params: (string | number)[], term: string,
): number {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM extracted_memories em
       WHERE ${where}
         AND em.id IN (SELECT rowid FROM extracted_memories_fts WHERE extracted_memories_fts MATCH ?)`,
    ).get(...params, `"${term.replace(/"/g, "")}"`) as { c: number } | undefined;
    return row?.c ?? 0;
  } catch (err) {
    logTrace(TAG, `Sf coverage df failed for "${term.slice(0, 20)}": ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/**
 * #1861 — weight supplied translated terms by corpus document frequency:
 * rare terms carry more ranking information than filler distributed across
 * the store. Terms are deduplicated, never removed or rewritten.
 */
function buildCoverageTerms(
  db: Database.Database, where: string, params: (string | number)[], translated: readonly string[],
): CoverageTerm[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of translated) {
    const term = raw.trim();
    if (!term) continue;
    const key = stripDiacritics(term);
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  if (terms.length === 0) return [];
  let corpusSize = 0;
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM extracted_memories em WHERE ${where}`).get(...params) as { c: number } | undefined;
    corpusSize = row?.c ?? 0;
  } catch (err) {
    logTrace(TAG, `Sf coverage corpus size failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (corpusSize === 0) return terms.map((text) => ({ text, weight: 1 }));
  return terms.map((text) => ({
    text,
    weight: Math.log(1 + corpusSize / Math.max(1, termDocumentFrequency(db, where, params, text))),
  }));
}

function coverageScore(haystack: string, terms: readonly CoverageTerm[]): number {
  let score = 0;
  for (const term of terms) {
    if (hasTokenBoundaryMatch(haystack, term.text)) score += term.weight;
  }
  return score;
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

// ── #1836 bounded probe budget ─────────────────────────────────────────────
// A raw message can hold arbitrarily many words; the probe count must not
// scale with it. At most MAX_RESCUE_TERMS significant terms, one OR probe,
// two rescue probes per term, each hit-capped. Worst case: 2 + 8×2 probes.
const MAX_RESCUE_TERMS = 8;
const RESCUE_PER_TERM_CAP = 5;

/**
 * #1836 — significant terms in message order: unicode letter/digit runs
 * longer than 2 chars, deduplicated case-insensitively. No stopword list, no
 * language detection.
 */
export function extractSignificantTerms(texts: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const m of text.match(/[\p{L}\p{N}]+/gu) ?? []) {
      if (m.length <= 2) continue;
      const k = m.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(m);
      if (out.length >= MAX_RESCUE_TERMS) return out;
    }
  }
  return out;
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
      } catch (err) { logTrace(TAG, `Sf ${source}: window query failed (${err instanceof Error ? err.message : String(err)})`); }
    }
  } catch (err) { logTrace(TAG, `Sf ${source}: trigram query failed (${err instanceof Error ? err.message : String(err)})`); }
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
  // #1658: the one shared-or-owned predicate with the permanent class-3
  // ceiling. Sf stops returning class-3 rows even when the caller requests
  // maxClassification = 3 — that is the deliberate exposure fix.
  const vis = sharedOrOwnedClause("em", opts.userId, effectiveMaxClassification(opts.maxClassification));
  conditions.push(vis.sql);
  params.push(...vis.params);
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
    semanticRevision: row.semantic_revision,
  };
}

const MEM_COLS = `em.id, em.content_en, em.content_original, em.memory_type, em.created_at,
  em.source_message_ids, em.trust, em.integrity, em.credibility, em.classification,
  em.recall_count, COALESCE(em.relevance_score, 0) as relevance_score, em.preserved_keyword,
  em.semantic_revision`;

export function trigramSearch(db: Database.Database, opts: SfOptions): { hits: RecallHit[]; extractedIds: number[] } {
  const seen = new Set<number>();
  const hits: RecallHit[] = [];
  const extractedIds: number[] = [];
  const { where, params } = buildWhereClause(opts);
  const fetchLimit = opts.limit * 3;
  const isRawMessage = opts.translated.length === 1 && /\s/.test(opts.translated[0] ?? "");
  // Raw-message inputs keep the #1836 probe order; focused keyword queries are
  // re-ranked by coverage after the probes complete.
  const coverageTerms = isRawMessage ? [] : buildCoverageTerms(db, where, params, opts.translated);
  const coverageById = new Map<number, number>();

  const addRow = (row: MemRow, source: string): void => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    extractedIds.push(row.id);
    hits.push(rowToHit(row, source));
    if (coverageTerms.length > 0) {
      const haystack = [row.content_en ?? "", row.content_original ?? "", row.preserved_keyword ?? ""].join("\n");
      coverageById.set(row.id, coverageScore(haystack, coverageTerms));
    }
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
    } catch (err) { logTrace(TAG, `Sf porter query failed (${err instanceof Error ? err.message : String(err)})`); }
  }

  // Sf.2: Trigram on content_en + preserved_keyword (diacritics-stripped)
  // #1861 — runs unconditionally: a full porter pool is not evidence that the
  // substring probes have nothing to add. Raw-message inputs (one entry
  // holding a whole sentence) take the bounded probe path below instead.
  if (!isRawMessage) {
    const allKw = [...opts.translated];
    if (opts.original) allKw.push(opts.original);
    for (const kw of allKw) {
      trigramQuery(db, "content_en_trigram", kw, where, params, fetchLimit, addRow, "Sf:trigram_en");
    }
  }

  // #1836 — raw-message probe set: the full-phrase porter probe above stays
  // first (exact quotes still hit), then one OR-of-quoted-words probe over
  // significant terms, then per-term trigram rescue on both tables. Rescue
  // runs even when the pool is not thin: porter cannot bridge agglutinative
  // suffixes (gyulait vs Gyula) and unrelated OR hits would otherwise block
  // the only path that finds them. Dedup keeps first occurrences, so probe
  // order affects pool membership and (via Sf positions in fusion) rank.
  if (isRawMessage) {
    const texts = [...opts.translated];
    if (opts.original && opts.original !== opts.translated[0]) texts.push(opts.original);
    const terms = extractSignificantTerms(texts);
    if (terms.length > 0) {
      try {
        const orQuery = terms.map(kw => `"${kw.replace(/"/g, "")}"`).join(" OR ");
        const rows = db.prepare(
          `SELECT ${MEM_COLS} FROM extracted_memories_fts ft
           JOIN extracted_memories em ON ft.rowid = em.id
           WHERE extracted_memories_fts MATCH ? AND ${where}
           ORDER BY rank LIMIT ?`,
        ).all(orQuery, ...params, fetchLimit) as MemRow[];
        for (const r of rows) addRow(r, "Sf:porter");
      } catch (err) { logTrace(TAG, `Sf raw-message porter probe failed (${err instanceof Error ? err.message : String(err)})`); }
      for (const term of terms) {
        // A true per-term cap: trigramQuery runs internal fallback queries
        // (z-swap, substring windows) each with its own fetch limit, so the
        // fetchLimit argument alone cannot bound what one term adds. Count
        // additions here and stop adding once the cap is reached.
        const rescueTerm = (table: string, source: string): void => {
          let added = 0;
          const cappedAdd = (row: MemRow, src: string): void => {
            if (added >= RESCUE_PER_TERM_CAP) return;
            const before = hits.length;
            addRow(row, src);
            if (hits.length > before) added++;
          };
          trigramQuery(db, table, term, where, params, RESCUE_PER_TERM_CAP, cappedAdd, source);
        };
        rescueTerm("content_en_trigram", "Sf:trigram_en");
        rescueTerm("content_original_trigram", "Sf:trigram_orig");
      }
    }
  }

  // Sf.3: Trigram on content_original (original-language fallback)
  // #1861 — unconditional like Sf.2. Raw-message inputs use the per-term
  // rescue above instead; the whole-message keyword here would build fuzzy
  // windows over a sentence.
  if (!isRawMessage) {
    const allKw = [...opts.translated];
    if (opts.original) allKw.push(opts.original);
    for (const kw of allKw) {
      trigramQuery(db, "content_original_trigram", kw, where, params, fetchLimit, addRow, "Sf:trigram_orig");
    }
  }

  // #1861 — order the focused pool by weighted token-boundary coverage.
  // Stable sort: equal-coverage candidates keep their probe/BM25 order.
  if (coverageTerms.length > 0) {
    hits.sort((a, b) => (coverageById.get(b.id ?? -1) ?? 0) - (coverageById.get(a.id ?? -1) ?? 0));
  }

  const bySource = new Map<string, number>();
  for (const h of hits) bySource.set(h.source ?? "?", (bySource.get(h.source ?? "?") ?? 0) + 1);
  logDebug(TAG, `Sf: ${hits.length} hits (${[...bySource].map(([s, n]) => `${s}:${n}`).join(" ")}) keywords=${opts.translated.length} rawMessage=${isRawMessage} filters=${[opts.topic, opts.tier, opts.emotion].filter(Boolean).length} kw="${redactSecrets(opts.translated.join(" ")).slice(0, 60)}"`);
  return { hits, extractedIds };
}
