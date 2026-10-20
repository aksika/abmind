/**
 * fts-utils.ts — FTS5 query sanitization and accent folding for message
 * search. The retired extracted-memory scoring helpers went out with the
 * legacy search path (#1939 2a).
 */

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
