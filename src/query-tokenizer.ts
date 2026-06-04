/**
 * query-tokenizer — extract English-looking tokens from a raw user prompt.
 *
 * Used by abmind-hook-recall to bridge the "raw user input" → "translated
 * English query" gap. The recall pipeline's Sf stage runs three parallel
 * queries (porter FTS on content_en, trigram on content_en, trigram on
 * content_original). The hook feeds:
 *   - `translated` ← extractEnglishTokens(prompt)  (Sf EN path + Se embedding)
 *   - `original`   ← raw prompt                    (Sf original-trigram path)
 *
 * Heuristic, deliberately simple. No language detection, no Unicode magic,
 * no Hungarian-specific rules. The goal is to surface tokens that are
 * likely in content_en — empirically: proper nouns + English-cognate
 * technical terms. Everything else goes through `original`.
 *
 * See abproject/docs/plans/abmind-hook-recall-translation.md for the
 * design rationale.
 */

const STOPWORDS = new Set([
  // Articles, conjunctions, common prepositions
  "the", "and", "for", "but", "nor", "yet", "with", "from", "into", "onto",
  "about", "above", "below", "under", "over", "between", "through", "during",
  // Common verbs that rarely disambiguate recall
  "are", "was", "were", "been", "being", "have", "has", "had", "does", "did",
  "can", "could", "would", "should", "will", "shall", "may", "might", "must",
  // Pronouns
  "this", "that", "these", "those", "there", "here", "what", "which",
  "who", "whom", "whose", "when", "where", "why", "how",
  "you", "your", "yours", "they", "them", "their", "theirs",
  // Misc fillers
  "just", "only", "also", "even", "than", "then", "too", "very",
  "some", "any", "all", "none", "few", "many", "much", "most", "more", "less",
  "like", "such", "other", "another", "each", "every", "both", "either",
]);

const PROPER_NOUN_RE = /^[A-Z][a-zA-Z0-9]+$|^[A-Z]{2,}$/;
const ASCII_TOKEN_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const MIN_LEN = 3;

/**
 * Extract tokens from a prompt that are likely to appear in English-indexed
 * memory content. Returns an empty array if nothing qualifies — callers
 * should fall back to raw-prompt behavior in that case.
 *
 * Rules:
 *   - Split on whitespace + punctuation
 *   - Keep ASCII-only tokens (rejects Hungarian-specific chars: áéíóöőúüű)
 *   - Keep tokens of length ≥ 3
 *   - Proper nouns (capitalized, matches PROPER_NOUN_RE) always kept, case preserved
 *   - Non-proper-noun tokens lowercased then stopword-filtered
 *   - Deduplicated, order preserved from first occurrence
 */
export function extractEnglishTokens(prompt: string): string[] {
  if (!prompt || typeof prompt !== "string") return [];

  // Split on anything that isn't an ASCII word char or Unicode letter.
  // We want to let the regex see diacritics so we can then reject them
  // in the ASCII test — splitting on them would merge Hungarian words.
  const rawTokens = prompt.split(/[^\p{L}\p{N}_-]+/u).filter(t => t.length > 0);

  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of rawTokens) {
    // #530: allow 2-char uppercase tokens (acronyms: KP, AI, DB)
    if (raw.length < MIN_LEN && raw !== raw.toUpperCase()) continue;

    // Proper noun path — case sensitive check, kept as-is.
    if (PROPER_NOUN_RE.test(raw)) {
      if (!seen.has(raw)) {
        seen.add(raw);
        out.push(raw);
      }
      continue;
    }

    // Regular token path — must be pure ASCII letters/digits.
    if (!ASCII_TOKEN_RE.test(raw)) continue;
    const lower = raw.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(lower);
    }
  }

  return out;
}
