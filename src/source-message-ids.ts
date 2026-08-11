/**
 * Exact parser/canonicalizer for the comma-separated `source_message_ids`
 * column. Deletion and message-to-memory lookups must use exact parsed
 * membership, never SQL substring matching, so that ID `12` never matches
 * source ID `112`.
 */

export const MAX_SOURCE_MESSAGE_IDS = 512;

const TOKEN_RE = /^[0-9]+$/;

/** Bounded integrity error — carries no source content. */
export class SourceMessageIdsError extends Error {
  constructor() {
    super("malformed source message ids");
    this.name = "SourceMessageIdsError";
  }
}

/**
 * Parse a comma-separated source message ID list into unique positive safe
 * integers in caller order. Null, undefined, and blank input produce an empty
 * list. Malformed input throws `SourceMessageIdsError`.
 */
export function parseSourceMessageIds(value: string | null | undefined): number[] {
  if (value == null) return [];
  const trimmed = value.trim();
  if (trimmed === "") return [];

  const parts = trimmed.split(",");
  const seen = new Set<number>();
  const out: number[] = [];
  for (const part of parts) {
    const token = part.trim();
    if (!TOKEN_RE.test(token)) throw new SourceMessageIdsError();
    const n = Number(token);
    if (!Number.isSafeInteger(n) || n < 1) throw new SourceMessageIdsError();
    if (seen.has(n)) throw new SourceMessageIdsError();
    seen.add(n);
    out.push(n);
  }
  if (out.length > MAX_SOURCE_MESSAGE_IDS) throw new SourceMessageIdsError();
  return out;
}

/**
 * Canonicalize a comma-separated source message ID list for storage: unique
 * decimal IDs joined by commas in caller order. Null/blank input stores null.
 */
export function canonicalizeSourceMessageIds(value: string | null | undefined): string | null {
  const ids = parseSourceMessageIds(value);
  if (ids.length === 0) return null;
  return ids.join(",");
}
