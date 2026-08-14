/**
 * sealed-migration.ts — reviewed, decision-file-driven migration of legacy
 * class-3 rows to the versioned sealed representation (#1660).
 *
 * No `--apply` equivalent here: this service only supports a metadata-only
 * dry run and a decision-covered apply. Every legacy class-3 row must carry an
 * explicit operator decision (`seal` with a descriptive label, `declassify`
 * with an explicit non-sealed projection, or `leave_quarantined` which keeps
 * the row at format 0 and therefore undiscoverable/unresolvable).
 *
 * Output and evidence never contain class-3 content, keywords, fragments,
 * decision-file labels or handles. Index cleanup relies on the normal
 * `extracted_memories_au` / `content_en_trigram_au` /
 * `content_original_trigram_au` triggers; the virtual tables are never
 * manipulated directly here.
 */

import type Database from "better-sqlite3";
import { decrypt } from "./crypto.js";
import { createSealedProjection, SEALED_FORMAT_VERSION } from "./sealed-memory.js";
import { generateSignature } from "./signature-generator.js";

export type SealedMigrationDecision =
  | { memoryId: number; expectedRevision: number; action: "seal"; label: string; keyword?: string }
  | { memoryId: number; expectedRevision: number; action: "declassify"; classification: 2; contentEn: string; contentOriginal: string }
  | { memoryId: number; expectedRevision: number; action: "leave_quarantined" };

export type SealedMigrationCandidate = {
  memoryId: number;
  userId: string;
  semanticRevision: number;
  classification: number;
  encrypted: number;
  sealedFormatVersion: number;
};

export type SealedMigrationPlan = {
  candidates: SealedMigrationCandidate[];
  /** False when the external-content FTS index reports corruption. */
  ftsIntegrityOk: boolean;
};

export type SealedMigrationOutcome =
  | { ok: true; sealed: number[]; declassified: number[]; quarantined: number[]; ftsRebuilt: boolean }
  | { ok: false; refused: string };

const CANDIDATE_SQL = `
  SELECT id, user_id, semantic_revision, classification, encrypted, sealed_format_version
  FROM extracted_memories
  WHERE classification >= 3
    AND (encrypted = 0 OR encrypted IS NULL OR sealed_format_version IS NULL OR sealed_format_version != 1)
  ORDER BY id
`;

function ftsIntegrityOk(db: Database.Database): boolean {
  try {
    db.prepare("INSERT INTO extracted_memories_fts(extracted_memories_fts) VALUES('integrity-check')").run();
    return true;
  } catch {
    return false;
  }
}

/**
 * Metadata-only dry run: candidate ids/revisions/format booleans and the FTS
 * integrity result. Never reads content columns.
 */
export function inspectSealedMigration(db: Database.Database): SealedMigrationPlan {
  const rows = db.prepare(CANDIDATE_SQL).all() as Array<{
    id: number;
    user_id: string;
    semantic_revision: number;
    classification: number;
    encrypted: number;
    sealed_format_version: number;
  }>;
  const candidates: SealedMigrationCandidate[] = rows.map((row) => ({
    memoryId: row.id,
    userId: row.user_id,
    semanticRevision: row.semantic_revision,
    classification: row.classification,
    encrypted: row.encrypted,
    sealedFormatVersion: row.sealed_format_version,
  }));
  return { candidates, ftsIntegrityOk: ftsIntegrityOk(db) };
}

/**
 * Apply reviewed decisions in one transaction.
 *
 * Requires a verified encrypted backup (`verifiedBackup: true`). Re-inspects,
 * rejects unknown/duplicate/stale/missing decisions, and updates every target
 * under its (id, user_id, semantic_revision) + class-3 predicate with exactly
 * one affected row. Normal triggers refresh FTS/trigram indexes. When the
 * dry-run reported FTS corruption, the external-content index is rebuilt once.
 */
export function applySealedMigration(
  db: Database.Database,
  decisions: readonly SealedMigrationDecision[],
  opts: { verifiedBackup: boolean },
): SealedMigrationOutcome {
  if (!opts.verifiedBackup) {
    return { ok: false, refused: "apply requires a verified encrypted backup — create and verify one first" };
  }

  const plan = inspectSealedMigration(db);
  const byId = new Map(plan.candidates.map((c) => [c.memoryId, c]));

  if (plan.candidates.length === 0) {
    return { ok: true, sealed: [], declassified: [], quarantined: [], ftsRebuilt: false };
  }

  // Validate decisions before any mutation.
  const seen = new Set<number>();
  for (const decision of decisions) {
    if (!Number.isSafeInteger(decision.memoryId) || decision.memoryId < 1) {
      return { ok: false, refused: `decision references an invalid memory id` };
    }
    if (seen.has(decision.memoryId)) {
      return { ok: false, refused: `duplicate decision for memory ${decision.memoryId}` };
    }
    seen.add(decision.memoryId);
    const candidate = byId.get(decision.memoryId);
    if (!candidate) {
      return { ok: false, refused: `decision references unknown or already-migrated memory ${decision.memoryId}` };
    }
    const action: SealedMigrationDecision["action"] = decision.action;
    if (action !== "seal" && action !== "declassify" && action !== "leave_quarantined") {
      return { ok: false, refused: `unknown action for memory ${decision.memoryId}` };
    }
    if (decision.action === "seal") {
      if (!decision.label || !decision.label.trim()) {
        return { ok: false, refused: `seal decision for memory ${decision.memoryId} requires a non-empty label` };
      }
    } else if (decision.action === "declassify") {
      if (decision.classification !== 2 || !decision.contentEn.trim() || !decision.contentOriginal.trim()) {
        return { ok: false, refused: `declassify decision for memory ${decision.memoryId} requires classification 2 and explicit content` };
      }
    }
    if (decision.expectedRevision !== candidate.semanticRevision) {
      return { ok: false, refused: `stale decision for memory ${decision.memoryId}: expected revision ${candidate.semanticRevision}, got ${decision.expectedRevision}` };
    }
  }
  for (const candidate of plan.candidates) {
    if (!seen.has(candidate.memoryId)) {
      return { ok: false, refused: `no decision for legacy class-3 memory ${candidate.memoryId}` };
    }
  }

  const sealed: number[] = [];
  const declassified: number[] = [];
  const quarantined: number[] = [];

  try {
    const txn = db.transaction(() => {
      const select = db.prepare(
        "SELECT id, user_id, content_original, encrypted FROM extracted_memories WHERE id = ? AND user_id = ? AND semantic_revision = ? AND classification >= 3",
      );
      const sealUpdate = db.prepare(`
        UPDATE extracted_memories SET
          content_original = ?, content_en = ?, preserved_keyword = ?,
          encrypted = 1, sealed_format_version = ?, embedding = NULL, signature = ?,
          semantic_revision = semantic_revision + 1
        WHERE id = ? AND user_id = ? AND semantic_revision = ? AND classification >= 3
      `);
      const declassifyUpdate = db.prepare(`
        UPDATE extracted_memories SET
          content_en = ?, content_original = ?, encrypted = 0,
          sealed_format_version = 0, classification = 2, embedding = NULL, signature = ?,
          semantic_revision = semantic_revision + 1
        WHERE id = ? AND user_id = ? AND semantic_revision = ? AND classification >= 3
      `);

      for (const decision of decisions) {
        if (decision.action === "leave_quarantined") {
          quarantined.push(decision.memoryId);
          continue;
        }
        const candidate = byId.get(decision.memoryId)!;
        const row = select.get(decision.memoryId, candidate.userId, candidate.semanticRevision) as
          | { id: number; user_id: string; content_original: string; encrypted: number }
          | undefined;
        if (!row) {
          throw new Error(`memory ${decision.memoryId} changed before apply — re-run the dry run`);
        }

        if (decision.action === "seal") {
          // Encrypts a plaintext original only when needed; already-encrypted
          // originals are decrypted with the current key first.
          let exactValue = row.content_original;
          if (row.encrypted === 1) {
            exactValue = decrypt(row.content_original);
          }
          const projection = createSealedProjection({
            exactValue,
            label: decision.label.trim(),
            keyword: decision.keyword,
          });
          const result = sealUpdate.run(
            projection.contentOriginal,
            projection.contentEn,
            projection.preservedKeyword,
            projection.sealedFormatVersion,
            Buffer.from(generateSignature(projection.contentEn)),
            decision.memoryId,
            candidate.userId,
            candidate.semanticRevision,
          );
          if (result.changes !== 1) {
            throw new Error(`seal of memory ${decision.memoryId} affected ${result.changes} rows`);
          }
          sealed.push(decision.memoryId);
        } else {
          const result = declassifyUpdate.run(
            decision.contentEn.trim(),
            decision.contentOriginal.trim(),
            Buffer.from(generateSignature(decision.contentEn.trim())),
            decision.memoryId,
            candidate.userId,
            candidate.semanticRevision,
          );
          if (result.changes !== 1) {
            throw new Error(`declassify of memory ${decision.memoryId} affected ${result.changes} rows`);
          }
          declassified.push(decision.memoryId);
        }
      }
    });
    txn();
  } catch (err) {
    return { ok: false, refused: `migration refused, no rows mutated: ${err instanceof Error ? err.message : String(err)}` };
  }

  // The replaced encrypt-secrets command issued an external-content delete
  // with an empty value; a DB where it ran may already have stale postings.
  let ftsRebuilt = false;
  if (!plan.ftsIntegrityOk) {
    try {
      db.exec("INSERT INTO extracted_memories_fts(extracted_memories_fts) VALUES('rebuild')");
      ftsRebuilt = true;
    } catch { /* best effort — triggers keep future updates consistent */ }
  }

  return { ok: true, sealed, declassified, quarantined, ftsRebuilt };
}

/** Format marker used to keep version checks literal. */
export const MIGRATION_TARGET_FORMAT = SEALED_FORMAT_VERSION;
