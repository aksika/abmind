/**
 * trigram-search.ts — shared token helpers for retrieval.
 *
 * #1928 M4 retired the legacy Sf retrieval stage (owned projections serve
 * all maintained recall); #1939 2a removed its df/classify/probe machinery
 * with the ambient planner that consumed it. What remains are the two
 * helpers the owned pipeline still uses: token-boundary matching and
 * significant-term extraction. No stopword list, no language detection.
 */

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

// Bound significant-term output: a raw message holds arbitrarily many words,
// and callers cap per-term rescue work downstream.
const MAX_RESCUE_TERMS = 8;

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
