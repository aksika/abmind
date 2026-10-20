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

/** Legacy personal tables disappear once the legacy model is removed (#1939);
 *  sealed search/resolution must then serve new-model durables only. Each
 *  index can be dropped separately, so presence is checked per object. */
function hasTable(db: Database.Database, name: string): boolean {
  return db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type IN ('table','virtual') AND name = ?",
  ).get(name) !== undefined;
}
function legacySearchPresent(db: Database.Database): boolean {
  return hasTable(db, "extracted_memories") && hasTable(db, "extracted_memories_fts") && hasTable(db, "content_en_trigram");
}

/**
 * Bounded label search for one owner's version-1 sealed rows, legacy and
 * new-model alike. Returns metadata only — labels, never values. Legacy
 * rows match over FTS/trigram; sealed durables carry no serving documents,
 * so their labels match over a bounded content LIKE. Deterministic
 * ordering: created_at DESC, then id DESC across both sources.
 */
export function findSealedSecrets(
  db: Database.Database,
  input: FindSealedSecretsInput,
): SealedSecretRefV1[] {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), MAX_SEALED_LIMIT);
  const userId = input.userId.trim();
  if (!userId) return [];

  const out: SealedSecretRefV1[] = [];
  const ftsQuery = sanitizeFtsQuery(input.query, "or");
  if (ftsQuery && legacySearchPresent(db)) {
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
    for (const row of rows) {
      out.push({
        memoryId: row.id,
        semanticRevision: row.semantic_revision,
        label: row.content_en,
        memoryType: row.memory_type,
        createdAt: row.created_at,
      });
    }
  }

  // New-model sealed durables have no FTS/trigram documents by design, so
  // the label matches directly. The LIKE pattern escapes its wildcards; the
  // label column never holds a value.
  const like = input.query.trim().replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  if (like) {
    const durableRows = db.prepare(`
      SELECT id, revision, content, memory_type, created_at
      FROM long_term_memories
      WHERE user_id = ? AND classification >= 3 AND sealed_format_version = 1 AND encrypted = 1
        AND superseded_by_id IS NULL AND content LIKE ? ESCAPE '\\'
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(userId, `%${like}%`, limit) as Array<{
      id: number;
      revision: number;
      content: string;
      memory_type: string;
      created_at: number;
    }>;
    for (const row of durableRows) {
      out.push({
        memoryId: row.id,
        semanticRevision: row.revision,
        label: row.content,
        memoryType: row.memory_type,
        createdAt: row.created_at,
      });
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt || b.memoryId - a.memoryId);
  return out.slice(0, limit);
}

/**
 * Revision-checked plaintext resolver. Requires exact owner, class 3+, format
 * 1, encrypted 1, current revision and an unexpired row — only then decrypts.
 * Legacy rows resolve first (existing behavior); new-model sealed durables
 * resolve next under the same guards plus a current (non-superseded)
 * revision. Every failure returns the same indistinguishable
 * `sealed_resolution_failed`.
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
  const row = hasTable(db, "extracted_memories")
    ? db.prepare(`
        SELECT content_original, semantic_revision
        FROM extracted_memories
        WHERE id = ?
          AND ${visibility.sql}
          AND semantic_revision = ?
      `).get(input.memoryId, ...visibility.params, input.expectedRevision) as
        | { content_original: string; semantic_revision: number }
        | undefined
    : undefined;

  if (row) {
    try {
      const value = decrypt(row.content_original);
      return { ok: true, value, semanticRevision: row.semantic_revision };
    } catch {
      return { ok: false, code: "sealed_resolution_failed" };
    }
  }

  const durable = db.prepare(`
    SELECT content_original, revision
    FROM long_term_memories
    WHERE id = ?
      AND user_id = ? AND classification >= 3 AND sealed_format_version = 1 AND encrypted = 1
      AND superseded_by_id IS NULL AND valid_to IS NULL
      AND revision = ?
  `).get(input.memoryId, input.userId.trim(), input.expectedRevision) as
    | { content_original: string; revision: number }
    | undefined;

  if (!durable) {
    return { ok: false, code: "sealed_resolution_failed" };
  }

  try {
    const value = decrypt(durable.content_original);
    return { ok: true, value, semanticRevision: durable.revision };
  } catch {
    return { ok: false, code: "sealed_resolution_failed" };
  }
}
