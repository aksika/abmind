/** Recall storage boundary; #1928 owns indexed ranking and pipeline integration.
 * The unprofiled newest-row fallback is retired: maintained recall routes
 * use the owned-v1 contract (see owned-recall.ts). This module retains only
 * the deterministic skip verdict and the raw-evidence safety check. */
import type Database from "better-sqlite3";

function keywordsOf(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
}

/**
 * New-model equivalent of the legacy raw-turn skip (#1877): when every
 * informative query term is over-common in this owner's durable + episode
 * corpus, the turn carries no discriminating evidence and recall is a pure
 * omission. Same constants as the retired heuristic (minimum corpus 5,
 * ceiling max(2, floor(corpus / 4))). Explicit callers never skip.
 */
export function personalSkipVerdict(
  db: Database.Database,
  owner: string,
  query: string,
  maxClassification = 2,
): boolean {
  const candidates = keywordsOf(query).filter((t) => t.length >= 3);
  if (candidates.length === 0) return true;
  let corpus = 0;
  try {
    corpus = (db.prepare(
      "SELECT (SELECT COUNT(*) FROM long_term_memories WHERE user_id = ? AND classification <= ?) + (SELECT COUNT(*) FROM short_term_memories WHERE user_id = ? AND classification <= ?) AS c",
    ).get(owner, maxClassification, owner, maxClassification) as { c: number }).c;
  } catch {
    return false;
  }
  if (corpus < 5) return false;
  const ceiling = Math.max(2, Math.floor(corpus / 4));
  for (const term of candidates) {
    const like = `%${term}%`;
    let df = 0;
    try {
      df = (db.prepare(
        "SELECT (SELECT COUNT(*) FROM long_term_memories WHERE user_id = ? AND classification <= ? AND (content LIKE ? OR COALESCE(content_original, '') LIKE ?)) + (SELECT COUNT(*) FROM short_term_memories WHERE user_id = ? AND classification <= ? AND (topic LIKE ? OR COALESCE(outcomes, '') LIKE ? OR COALESCE(unresolved, '') LIKE ?)) AS df",
      ).get(owner, maxClassification, like, like, owner, maxClassification, like, like, like) as { df: number }).df;
    } catch {
      return false;
    }
    if (df <= ceiling) return false;
  }
  return true;
}
/** Only grounded, authorized excerpts can expand into retained raw evidence. */
export function rawEvidenceSafe(db: Database.Database, owner: string, id: number, maxClassification = 2): boolean {  const classified = db.prepare("SELECT MAX(classification) AS level FROM extracted_memories WHERE user_id = ? AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(source_message_ids) THEN source_message_ids ELSE '[]' END) WHERE CAST(value AS TEXT) = ?)").get(owner, String(id)) as { level: number | null };
  if ((classified.level ?? 0) > Math.min(maxClassification, 2)) return false;
  const sealedEpisode = db.prepare("SELECT 1 FROM short_term_memories WHERE user_id = ? AND classification > ? AND EXISTS (SELECT 1 FROM json_each(source_message_ids) WHERE CAST(value AS TEXT) = ?) LIMIT 1").get(owner, Math.min(maxClassification, 2), String(id));
  return !sealedEpisode;
}
