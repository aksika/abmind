/**
 * sealed-secret-service.ts — bounded owner-only sealed search and the
 * local-only plaintext resolver for version-1 sealed rows (#1660).
 *
 * Sealed search returns metadata only (id, revision, label, type, created_at)
 * through a dedicated projection that cannot contain `content_original`. It
 * searches only `extracted_memories_fts` and `content_en_trigram`; it never
 * touches original trigram, signature, embedding, consolidation, timeline or
 * graph surfaces, and it does not reuse `RecallHit`.
 *
 * The resolver decrypts only after exact owner + class 3 + format 1 +
 * encrypted 1 + current revision + unexpired checks, and its failures are
 * indistinguishable across wrong-owner/wrong-revision/expired/version-0 so a
 * caller cannot learn whether another owner's row exists. Dispatch-level
 * authorization (embedded/local-peer only) lives in `abmind-service.ts`.
 */

import type Database from "better-sqlite3";
import { sanitizeFtsQuery } from "./fts-utils.js";
import { decrypt } from "./crypto.js";
import { sealedSearchVisibility } from "./memory-visibility.js";

export type SealedSecretRefV1 = {
  readonly memoryId: number;
  readonly semanticRevision: number;
  readonly label: string;
  readonly memoryType: string;
  readonly createdAt: number;
};

export type FindSealedSecretsInput = {
  readonly userId: string;
  readonly query: string;
  readonly limit?: number;
};

export type ResolveSealedSecretInput = {
  readonly userId: string;
  readonly memoryId: number;
  readonly expectedRevision: number;
};

export type ResolveSealedSecretResult =
  | { ok: true; value: string; semanticRevision: number }
  | { ok: false; code: "sealed_resolution_failed" };

const MAX_SEALED_LIMIT = 25;

/**
 * Bounded FTS/trigram label search for one owner's version-1 sealed rows.
 * Deterministic ordering: rank, then created_at DESC, then id DESC. Dedupes
 * by id across the two indexes.
 */
export function findSealedSecrets(
  db: Database.Database,
  input: FindSealedSecretsInput,
): SealedSecretRefV1[] {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), MAX_SEALED_LIMIT);
  const userId = input.userId.trim();
  if (!userId) return [];

  const ftsQuery = sanitizeFtsQuery(input.query, "or");
  if (!ftsQuery) return [];

  const visibility = sealedSearchVisibility(userId, "em");
  const rows = db.prepare(`
    WITH matched AS (
      SELECT rowid AS id, rank AS rank
      FROM extracted_memories_fts
      WHERE extracted_memories_fts MATCH ?
      UNION ALL
      SELECT rowid AS id, 0.0 AS rank
      FROM content_en_trigram
      WHERE content_en_trigram MATCH ?
    ), ranked AS (
      SELECT id, MIN(rank) AS rank
      FROM matched
      GROUP BY id
    )
    SELECT em.id, em.semantic_revision, em.content_en, em.memory_type, em.created_at, ranked.rank
    FROM ranked
    JOIN extracted_memories em ON em.id = ranked.id
    WHERE ${visibility.sql}
    ORDER BY ranked.rank, em.created_at DESC, em.id DESC
    LIMIT ?
  `).all(ftsQuery, ftsQuery, ...visibility.params, limit) as Array<{
    id: number;
    semantic_revision: number;
    content_en: string;
    memory_type: string;
    created_at: number;
  }>;

  return rows.map((row) => ({
    memoryId: row.id,
    semanticRevision: row.semantic_revision,
    label: row.content_en,
    memoryType: row.memory_type,
    createdAt: row.created_at,
  }));
}

/**
 * Revision-checked plaintext resolver. Requires exact owner, class 3+, format
 * 1, encrypted 1, current revision and an unexpired row — only then decrypts.
 * Every failure returns the same indistinguishable `sealed_resolution_failed`.
 */
export function resolveSealedSecret(
  db: Database.Database,
  input: ResolveSealedSecretInput,
): ResolveSealedSecretResult {
  if (!Number.isSafeInteger(input.memoryId) || input.memoryId < 1
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
    || !input.userId.trim()) {
    return { ok: false, code: "sealed_resolution_failed" };
  }

  const visibility = sealedSearchVisibility(input.userId.trim());
  const row = db.prepare(`
    SELECT content_original, semantic_revision
    FROM extracted_memories
    WHERE id = ?
      AND ${visibility.sql}
      AND semantic_revision = ?
  `).get(input.memoryId, ...visibility.params, input.expectedRevision) as
    | { content_original: string; semantic_revision: number }
    | undefined;

  if (!row) {
    return { ok: false, code: "sealed_resolution_failed" };
  }

  try {
    const value = decrypt(row.content_original);
    return { ok: true, value, semanticRevision: row.semantic_revision };
  } catch {
    return { ok: false, code: "sealed_resolution_failed" };
  }
}
