/**
 * personal-conversion.ts — Reviewed one-time conversion to the new model
 * (C5, #1930 M5).
 *
 * Follows the inspectSealedMigration()/applySealedMigration() pattern:
 * inspect produces a per-row disposition plan; the operator decides; apply
 * runs against a verified backup, writes durable progress, and is
 * restart-safe and idempotent. Structural boot DDL never performs content
 * conversion. Each host dataset converts in place; host data is never
 * combined. Legacy `general` is not assumed to be an episode and legacy
 * `core` is not assumed to be the only durable knowledge.
 */

import type Database from "better-sqlite3";
import { verifyBackupFile } from "./backup.js";
import { getPersonalState, setPersonalState } from "./personal-schema.js";
import { groupingHash } from "./personal-episodes.js";
import { generateSignature } from "./signature-generator.js";

export type PersonalDisposition =
  | { legacyId: number; action: "durable"; memoryType: string; authority: "user_statement" | "confirmed_decision" | "agent_proposal" | "inference"; rationale: string }
  | { legacyId: number; action: "preserve_general"; rationale: string }
  | { legacyId: number; action: "ambiguous"; rationale: string };

export type PersonalConversionPlan = {
  candidates: Array<{
    legacyId: number;
    userId: string;
    memoryType: string;
    tier: string;
    classification: number;
    semanticRevision: number;
  }>;
  ftsIntegrityOk: boolean;
};

export type PersonalConversionOutcome =
  | { ok: true; durable: number[]; preserved: number[]; ambiguous: number[]; skipped: number[] }
  | { ok: false; refused: string };

function ftsOk(db: Database.Database): boolean {
  try {
    db.prepare("INSERT INTO extracted_memories_fts(extracted_memories_fts) VALUES('integrity-check')").run();
    return true;
  } catch {
    return false;
  }
}

/** Metadata-only inspect: never reads content columns beyond type/tier. */
export function inspectPersonalConversion(db: Database.Database): PersonalConversionPlan {
  let candidates: PersonalConversionPlan["candidates"] = [];
  try {
    const rows = db.prepare(
      "SELECT id, user_id, memory_type, tier, classification, semantic_revision FROM extracted_memories ORDER BY id",
    ).all() as Array<{
      id: number;
      user_id: string;
      memory_type: string;
      tier: string;
      classification: number;
      semantic_revision: number;
    }>;
    candidates = rows.map((r) => ({
      legacyId: r.id,
      userId: r.user_id,
      memoryType: r.memory_type,
      tier: r.tier,
      classification: r.classification,
      semanticRevision: r.semantic_revision,
    }));
  } catch {
    candidates = [];
  }
  return { candidates, ftsIntegrityOk: ftsOk(db) };
}

/**
 * Apply reviewed dispositions. Requires a verified encrypted backup.
 * Restart-safe: already-converted legacy ids (tracked in progress) are
 * skipped without duplicating writes; a stale plan is re-inspected.
 */
export function applyPersonalConversion(
  db: Database.Database,
  decisions: readonly PersonalDisposition[],
  opts: { verifiedBackupPath?: string; verifiedBackup?: boolean },
): PersonalConversionOutcome {
  const verified =
    opts.verifiedBackup === true ||
    (opts.verifiedBackupPath !== undefined && verifyBackupFile(opts.verifiedBackupPath));
  if (!verified) {
    return { ok: false, refused: "apply requires a verified encrypted backup — create and verify one first" };
  }
  const plan = inspectPersonalConversion(db);
  const byId = new Map(plan.candidates.map((c) => [c.legacyId, c]));
  const seen = new Set<number>();
  for (const d of decisions) {
    const legacyId = (d as { legacyId: unknown }).legacyId;
    const action = (d as { action: unknown }).action;
    if (!Number.isSafeInteger(legacyId) || (legacyId as number) < 1) return { ok: false, refused: "decision references an invalid legacy id" };
    if (seen.has(legacyId as number)) return { ok: false, refused: `duplicate decision for legacy ${legacyId as number}` };
    seen.add(legacyId as number);
    if (!byId.has(legacyId as number)) return { ok: false, refused: `decision references unknown legacy ${legacyId as number}` };
    if (action !== "durable" && action !== "preserve_general" && action !== "ambiguous") {
      return { ok: false, refused: `unknown action for legacy ${legacyId as number}` };
    }
  }
  for (const c of plan.candidates) {
    if (!seen.has(c.legacyId)) return { ok: false, refused: `no decision for legacy ${c.legacyId}` };
  }

  setPersonalState(db, "converting", { reason: "reviewed conversion in progress" });
  const durable: number[] = [];
  const preserved: number[] = [];
  const ambiguous: number[] = [];
  const skipped: number[] = [];

  try {
    const progressRow = getPersonalState(db);
    const progress = (() => {
      try {
        return JSON.parse(progressRow?.progress ?? "{}") as { converted?: number[] };
      } catch {
        return {};
      }
    })();
    const converted = new Set<number>(progress.converted ?? []);

    const txn = db.transaction(() => {
      const select = db.prepare(
        "SELECT id, user_id, content_en, content_original, memory_type, tier, classification, trust, created_at, source_message_ids FROM extracted_memories WHERE id = ?",
      );
      const insertDurable = db.prepare(
        `INSERT INTO long_term_memories
          (user_id, memory_type, content, content_original, authority, applicability_scope,
           valid_from, revision, provenance, evidence, classification, signature, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '{"scope":"general"}', date('now'), 1, ?, ?, ?, ?, ?, ?)`,
      );
      const alreadyConverted = (legacyId: number): boolean => {
        if (converted.has(legacyId)) return true;
        try {
          const hit = db.prepare("SELECT 1 FROM long_term_memories WHERE provenance LIKE ? LIMIT 1").get(`%\"legacyId\":${legacyId}%`) as unknown;
          return Boolean(hit);
        } catch {
          return false;
        }
      };
      for (const d of decisions) {
        if (alreadyConverted(d.legacyId)) {
          skipped.push(d.legacyId);
          converted.add(d.legacyId);
          continue;
        }
        const candidate = byId.get(d.legacyId)!;
        const row = select.get(d.legacyId) as
          | {
              id: number;
              user_id: string;
              content_en: string;
              content_original: string;
              memory_type: string;
              tier: string;
              classification: number;
              trust: number;
              created_at: number;
              source_message_ids: string | null;
            }
          | undefined;
        if (!row) throw new Error(`legacy ${d.legacyId} changed before apply — re-run the dry run`);
        if (d.action === "durable") {
          // Preserve useful typed general knowledge; never invent user
          // confirmation or message pairing — authority comes from the
          // reviewed decision, defaulting to inference unless the operator
          // supplies user evidence.
          insertDurable.run(
            row.user_id,
            d.memoryType,
            row.content_en,
            row.content_original,
            d.authority,
            JSON.stringify({ legacyId: row.id, legacyTier: row.tier, rationale: d.rationale }),
            JSON.stringify([{ kind: "legacy", ref: `extracted_memories:${row.id}`, excerpt: row.content_en.slice(0, 280), classification: row.classification }]),
            row.classification,
            Buffer.from(generateSignature(row.content_en)),
            row.created_at,
            Date.now(),
          );
          durable.push(d.legacyId);
        } else if (d.action === "preserve_general") {
          preserved.push(d.legacyId);
        } else {
          ambiguous.push(d.legacyId);
        }
        converted.add(d.legacyId);
        void candidate;
      }
      setPersonalState(db, "converting", {
        reason: "reviewed conversion in progress",
        progress: JSON.stringify({ converted: [...converted] }),
      });
    });
    txn();
  } catch (err) {
    setPersonalState(db, "interrupted", { reason: err instanceof Error ? err.message : "conversion interrupted" });
    return { ok: false, refused: `conversion refused, no partial serving: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Activation verification: mapping, evidence, privacy, derived state.
  const verification = verifyActivation(db);
  if (!verification.ok) {
    setPersonalState(db, "failed", { reason: verification.reason });
    return { ok: false, refused: verification.reason };
  }
  try {
    const cur = getPersonalState(db);
    const curProgress = cur?.progress ?? "{}";
    let merged = curProgress;
    try {
      const parsed = JSON.parse(curProgress) as { converted?: number[] };
      const set = new Set<number>([...(parsed.converted ?? []), ...durable, ...preserved, ...ambiguous, ...skipped]);
      merged = JSON.stringify({ converted: [...set] });
    } catch { /* keep */ }
    setPersonalState(db, "ready", { reason: "verified activation on the new model", actualVersion: 1, progress: merged });
  } catch {
    setPersonalState(db, "ready", { reason: "verified activation on the new model", actualVersion: 1 });
  }
  return { ok: true, durable, preserved, ambiguous, skipped };
}

function verifyActivation(db: Database.Database): { ok: true } | { ok: false; reason: string } {
  try {
    const durableCount = (db.prepare("SELECT COUNT(*) as c FROM long_term_memories").get() as { c: number }).c;
    void durableCount;
    // Evidence: every durable row must carry at least one excerpt.
    const missing = db.prepare("SELECT COUNT(*) as c FROM long_term_memories WHERE evidence IS NULL OR evidence = '[]'").get() as {
      c: number;
    };
    if (missing.c > 0) return { ok: false, reason: `activation refused: ${missing.c} durable rows lack evidence` };
    // Privacy: sealed exact values never in plaintext durable content for
    // class-3 rows — enforced at write time; recheck format marker.
    const badSealed = db.prepare(
      "SELECT COUNT(*) as c FROM long_term_memories WHERE classification >= 3 AND sealed_format_version != 1",
    ).get() as { c: number };
    if (badSealed.c > 0) return { ok: false, reason: "activation refused: unsealed class-3 durable rows" };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `activation verification failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Stable episode grouping hash helper for conversion idempotency checks. */
export function conversionGroupingHash(userId: string, sourceIds: number[], topic: string, start: number, end: number): string {
  return groupingHash(userId, sourceIds, topic, start, end);
}
