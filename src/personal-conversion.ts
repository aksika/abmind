/** Reviewed one-time conversion. Schema version never implies content readiness. */
import type Database from "better-sqlite3";
import { verifyBackupFile } from "./backup.js";
import { getPersonalState, setPersonalState } from "./personal-schema.js";
import { groupingHash } from "./personal-episodes.js";
import { generateSignature } from "./signature-generator.js";
import { validatePersonalEvidence } from "./personal-evidence.js";
import { isUserAuthoritative } from "./personal-durable.js";

type ReviewedSource = { legacyId: number; userId: string; expectedRevision: number; rationale: string };
export type PersonalDisposition = ReviewedSource & (
  | { action: "durable"; memoryType: string; authority: "user_statement" | "confirmed_decision" | "agent_proposal" | "inference"; authorityEvidence?: Array<{ kind: string; ref: string; excerpt: string; classification: number }> }
  | { action: "preserve_general" }
  | { action: "ambiguous" }
  | { action: "forget" }
);
export type PersonalConversionPlan = {
  candidates: Array<{ legacyId: number; userId: string; memoryType: string; tier: string; classification: number; semanticRevision: number }>;
  ftsIntegrityOk: boolean;
};
export type PersonalConversionOutcome =
  | { ok: true; durable: number[]; preserved: number[]; ambiguous: number[]; skipped: number[]; forgotten: number[] }
  | { ok: false; refused: string };
export function inspectPersonalConversion(db: Database.Database): PersonalConversionPlan {
  const rows = db.prepare("SELECT id, user_id, memory_type, tier, classification, semantic_revision FROM extracted_memories ORDER BY id").all() as Array<{
    id: number; user_id: string; memory_type: string; tier: string; classification: number; semantic_revision: number;
  }>;
  let integrity = true;
  try { db.prepare("INSERT INTO extracted_memories_fts(extracted_memories_fts) VALUES('integrity-check')").run(); } catch { integrity = false; }
  return { candidates: rows.map(r => ({ legacyId: r.id, userId: r.user_id, memoryType: r.memory_type, tier: r.tier, classification: r.classification, semanticRevision: r.semantic_revision })), ftsIntegrityOk: integrity };
}
type LegacyRow = {
  id: number; user_id: string; content_en: string; content_original: string | null; memory_type: string;
  classification: number; tier: string; created_at: number; semantic_revision: number;
  valid_from: string | null; valid_to: string | null; encrypted: number; sealed_format_version: number; source_message_ids: string | null;
};
export function applyPersonalConversion(db: Database.Database, decisions: readonly PersonalDisposition[], opts: { verifiedBackupPath?: string; verifiedBackup?: boolean }): PersonalConversionOutcome {
  if (!(opts.verifiedBackup === true || (opts.verifiedBackupPath && verifyBackupFile(opts.verifiedBackupPath)))) return { ok: false, refused: "apply requires a verified encrypted backup" };
  if (!Array.isArray(decisions)) return { ok: false, refused: "reviewed decisions must be an array" };
  const plan = inspectPersonalConversion(db), byId = new Map(plan.candidates.map(c => [c.legacyId, c])), seen = new Set<number>();
  for (const d of decisions) {
    if (!d || !Number.isSafeInteger(d.legacyId) || seen.has(d.legacyId)) return { ok: false, refused: "invalid or duplicate reviewed legacy ID" };
    const source = byId.get(d.legacyId);
    if (!source || d.userId !== source.userId || d.expectedRevision !== source.semanticRevision) return { ok: false, refused: "stale or foreign conversion decision: re-inspect the source" };
    if (typeof d.rationale !== "string" || !d.rationale.trim() || !["durable", "preserve_general", "ambiguous", "forget"].includes(d.action)) return { ok: false, refused: "invalid reviewed disposition" };
    if (d.action === "durable" && (!["user_statement", "confirmed_decision", "agent_proposal", "inference"].includes(d.authority) || !d.memoryType?.trim())) return { ok: false, refused: "invalid durable disposition" };
    seen.add(d.legacyId);
  }
  if (seen.size !== plan.candidates.length) return { ok: false, refused: "every legacy row requires a reviewed decision" };
  const progress = getPersonalState(db)?.progress ?? "{}";
  if (decisions.some(d => d.action === "preserve_general" || d.action === "ambiguous")) {
    setPersonalState(db, "awaiting_decision", { reason: "unresolved or legacy-only dispositions cannot activate the new model", progress });
    return { ok: false, refused: "resolve every mapping into the new model before activation" };
  }
  setPersonalState(db, "converting", { reason: "reviewed conversion in progress", progress });
  const durable: number[] = [], skipped: number[] = [], forgotten: number[] = [];
  try {
    db.transaction(() => {
      for (const decision of decisions) {
        if (decision.action === "preserve_general" || decision.action === "ambiguous") throw new Error("unresolved disposition");
        const row = db.prepare("SELECT * FROM extracted_memories WHERE id = ? AND user_id = ? AND semantic_revision = ?")
          .get(decision.legacyId, decision.userId, decision.expectedRevision) as LegacyRow | undefined;
        if (!row) throw new Error("source changed during conversion; re-inspect");
        const converted = db.prepare("SELECT provenance FROM long_term_memories WHERE user_id = ? AND json_valid(provenance) AND json_extract(provenance, '$.legacyId') = ?")
          .get(row.user_id, row.id) as { provenance: string } | undefined;
        if (converted) {
          const metadata = JSON.parse(converted.provenance) as { legacyRevision?: number };
          if (metadata.legacyRevision !== row.semantic_revision) throw new Error("existing conversion does not match the reviewed source revision");
          skipped.push(row.id);
          continue;
        }
        if (decision.action === "forget") {
          // Reviewed deletion-marker / unrecoverable-sealed disposition: never
          // create a durable row. The legacy source stays in place for audit
          // but is not served once ready; progress records the exclusion so a
          // resume cannot resurrect it as durable.
          forgotten.push(row.id);
          continue;
        }
        if (row.classification >= 3 && (row.encrypted !== 1 || row.sealed_format_version !== 1)) throw new Error("legacy sealed rows require their reviewed sealing repair before conversion");
        if (isUserAuthoritative(decision.authority)) validatePersonalEvidence(db, row.user_id, decision.authorityEvidence ?? [], true);
        const evidence = decision.authorityEvidence ?? [{ kind: "legacy", ref: "extracted_memories:" + row.id, excerpt: row.content_en, classification: row.classification }];
        db.prepare("INSERT INTO long_term_memories (user_id,memory_type,content,content_original,authority,applicability_scope,valid_from,valid_to,revision,semantic_revision,provenance,evidence,classification,encrypted,sealed_format_version,signature,created_at,updated_at) VALUES (?,?,?,?,?,'{\"scope\":\"general\"}',?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(row.user_id, decision.memoryType, row.content_en, row.content_original, decision.authority,
            row.valid_from, row.valid_to, row.semantic_revision, row.semantic_revision,
            JSON.stringify({ legacyId: row.id, legacyRevision: row.semantic_revision, legacyTier: row.tier, sourceMessageIds: row.source_message_ids, rationale: decision.rationale }),
            JSON.stringify(evidence), row.classification, row.encrypted, row.sealed_format_version,
            row.classification >= 3 ? null : Buffer.from(generateSignature(row.content_en)), row.created_at, Date.now());
        durable.push(row.id);
      }
      if (db.prepare("SELECT 1 FROM forget_operations WHERE state = 'pending' LIMIT 1").get()) throw new Error("pending forgetting prevents activation");
      const missing = db.prepare("SELECT COUNT(*) AS c FROM long_term_memories WHERE evidence IS NULL OR evidence = '[]'").get() as { c: number };
      if (missing.c) throw new Error("converted knowledge lacks evidence");
      setPersonalState(db, "ready", { reason: "verified activation on the new model", actualVersion: 1, progress: JSON.stringify({ converted: [...durable, ...skipped], forgotten }) });
    })();
  } catch (err) {
    setPersonalState(db, "interrupted", { reason: err instanceof Error ? err.message : "conversion interrupted", progress });
    return { ok: false, refused: err instanceof Error ? err.message : "conversion interrupted" };
  }
  return { ok: true, durable, preserved: [], ambiguous: [], skipped, forgotten };
}
export function conversionGroupingHash(userId: string, sourceIds: number[], topic: string, start: number, end: number): string {
  return groupingHash(userId, sourceIds, topic, start, end);
}
