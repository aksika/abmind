/** Reviewed one-time re-own of non-primary Tier 2/3 rows to the manifest primary.
 * Single-master doctrine: episodes and durable knowledge belong only to the
 * canonical primary user; messages stay multi-principal raw evidence.
 * One transaction commits the full reviewed set or nothing; exact replay is a
 * no-op. No general owner-transfer facility: this module moves current durable
 * and episode rows to the manifest primary only, refusing any row whose
 * owner-linked history, supersession, grouping or forgetting dependencies
 * cannot remain coherent. Sealed bytes, flags and evidence are preserved
 * byte-identical; only user_id and additive provenance change.
 */
import type Database from "better-sqlite3";
import { verifyBackupFile } from "./backup.js";

export type ReownTargetKind = "durable" | "episode";
export interface ReownCandidate {
  kind: ReownTargetKind;
  id: number;
  sourceOwner: string;
  revision: number;
  classification: number;
  sealed: boolean;
  legacyId: number | null;
}
export interface ReownDecision {
  kind: ReownTargetKind;
  id: number;
  sourceOwner: string;
  expectedRevision: number;
  rationale: string;
}
export interface ReownPlan {
  primaryOwner: string;
  candidates: ReownCandidate[];
}
export type ReownOutcome =
  | { ok: true; reowned: Array<{ kind: ReownTargetKind; id: number }>; skipped: Array<{ kind: ReownTargetKind; id: number }> }
  | { ok: false; refused: string };

function legacyIdOf(provenance: string): number | null {
  try {
    const parsed = JSON.parse(provenance) as { legacyId?: unknown };
    return typeof parsed.legacyId === "number" && Number.isSafeInteger(parsed.legacyId) ? parsed.legacyId : null;
  } catch {
    return null;
  }
}

/** Metadata-only dry run: ids/owners/revisions/classification and legacy lineage. Never content. */
export function inspectReown(db: Database.Database, primaryOwner: string): ReownPlan {
  if (!primaryOwner.trim()) throw new Error("canonical owner unresolved (manifest primary required)");
  const candidates: ReownCandidate[] = [];
  const durables = db.prepare(
    "SELECT id, user_id, revision, classification, encrypted, sealed_format_version, provenance FROM long_term_memories WHERE user_id != ? ORDER BY id",
  ).all(primaryOwner) as Array<{ id: number; user_id: string; revision: number; classification: number; encrypted: number; sealed_format_version: number; provenance: string }>;
  for (const r of durables) {
    candidates.push({
      kind: "durable", id: r.id, sourceOwner: r.user_id, revision: r.revision,
      classification: r.classification, sealed: r.classification >= 3,
      legacyId: legacyIdOf(r.provenance),
    });
  }
  try {
    const episodes = db.prepare(
      "SELECT id, user_id, classification, encrypted FROM short_term_memories WHERE user_id != ? ORDER BY id",
    ).all(primaryOwner) as Array<{ id: number; user_id: string; classification: number; encrypted: number }>;
    for (const r of episodes) {
      candidates.push({
        kind: "episode", id: r.id, sourceOwner: r.user_id, revision: 1,
        classification: r.classification, sealed: r.classification >= 3, legacyId: null,
      });
    }
  } catch {
    // Structural table absent on old stores: durable-only plan.
  }
  return { primaryOwner, candidates };
}

export function applyPersonalReown(
  db: Database.Database,
  decisions: readonly ReownDecision[],
  opts: { verifiedBackupPath?: string; verifiedBackup?: boolean; primaryOwner?: string },
): ReownOutcome {
  if (!(opts.verifiedBackup === true || (opts.verifiedBackupPath && verifyBackupFile(opts.verifiedBackupPath)))) {
    return { ok: false, refused: "apply requires a verified encrypted backup" };
  }
  if (!Array.isArray(decisions)) return { ok: false, refused: "reviewed decisions must be an array" };
  const primaryOwner = opts.primaryOwner?.trim() ?? "";
  if (!primaryOwner) return { ok: false, refused: "canonical owner unresolved (manifest primary required)" };
  const plan = inspectReown(db, primaryOwner);
  // Idempotent replay: no non-primary rows remain. Every decision must name a
  // row now primary-owned with matching reownedFrom provenance.
  if (plan.candidates.length === 0) {
    if (decisions.length === 0) return { ok: true, reowned: [], skipped: [] };
    if (decisions.every((d) => isReplayedReown(db, d, primaryOwner))) {
      return { ok: true, reowned: [], skipped: decisions.map((d) => ({ kind: d.kind, id: d.id })) };
    }
    return { ok: false, refused: "stale or foreign re-own decision: re-inspect the target" };
  }
  const byKey = new Map(plan.candidates.map((c) => [`${c.kind}:${c.id}`, c]));
  const seen = new Set<string>();
  for (const d of decisions) {
    const key = `${d.kind}:${d.id}`;
    if ((d.kind !== "durable" && d.kind !== "episode") || !Number.isSafeInteger(d.id) || seen.has(key)) {
      return { ok: false, refused: "invalid or duplicate reviewed row" };
    }
    const candidate = byKey.get(key);
    if (!candidate || d.sourceOwner !== candidate.sourceOwner || d.expectedRevision !== candidate.revision) {
      return { ok: false, refused: "stale or foreign re-own decision: re-inspect the target" };
    }
    if (typeof d.rationale !== "string" || !d.rationale.trim()) return { ok: false, refused: "reviewed rationale required" };
    seen.add(key);
  }
  if (seen.size !== plan.candidates.length) {
    return { ok: false, refused: "every non-primary Tier 2/3 row requires a reviewed decision" };
  }

  const reowned: Array<{ kind: ReownTargetKind; id: number }> = [];
  const skipped: Array<{ kind: ReownTargetKind; id: number }> = [];
  try {
    db.transaction(() => {
      // Owner-linked forgetting state blocks the whole set; markers are
      // owner-keyed and must never be reinterpreted across owners.
      const pending = db.prepare("SELECT owner FROM forget_operations WHERE state = 'pending' LIMIT 1").get() as
        | { owner: string } | undefined;
      if (pending) throw new Error("pending forgetting prevents re-own; resolve it first");
      for (const decision of decisions) {
        if (decision.kind === "durable") {
          const row = db.prepare(
            "SELECT id, user_id, revision, provenance, evidence, content_original, classification, encrypted, sealed_format_version, supersedes_id, superseded_by_id FROM long_term_memories WHERE id = ?",
          ).get(decision.id) as
            | { id: number; user_id: string; revision: number; provenance: string; evidence: string; content_original: string | null; classification: number; encrypted: number; sealed_format_version: number; supersedes_id: number | null; superseded_by_id: number | null }
            | undefined;
          if (!row || row.user_id !== decision.sourceOwner || row.revision !== decision.expectedRevision) {
            throw new Error(`durable ${decision.id} changed before apply — re-inspect`);
          }
          if (row.user_id === primaryOwner) throw new Error(`durable ${decision.id} is already primary-owned`);
          if (row.supersedes_id !== null || row.superseded_by_id !== null) {
            throw new Error(`durable ${decision.id} carries supersession links that re-own cannot preserve`);
          }
          const history = (db.prepare("SELECT COUNT(*) AS c FROM long_term_revisions WHERE memory_id = ?").get(decision.id) as { c: number }).c;
          if (history > 0) throw new Error(`durable ${decision.id} carries owner-linked revision history`);
          const marked = (db.prepare("SELECT COUNT(*) AS c FROM forget_markers WHERE record_kind = 'durable' AND record_id = ?").get(decision.id) as { c: number }).c;
          if (marked > 0) throw new Error(`durable ${decision.id} carries forgetting markers`);
          const merged = mergeReownedFrom(row.provenance, decision.sourceOwner, row.revision, primaryOwner, decision.rationale);
          const result = db.prepare("UPDATE long_term_memories SET user_id = ?, provenance = ? WHERE id = ? AND user_id = ? AND revision = ?")
            .run(primaryOwner, merged, decision.id, decision.sourceOwner, decision.expectedRevision);
          if (result.changes !== 1) throw new Error(`durable ${decision.id} re-own affected ${result.changes} rows`);
          // Sealed bytes must survive the owner change untouched.
          const after = db.prepare("SELECT content_original, classification, encrypted, sealed_format_version, evidence FROM long_term_memories WHERE id = ?")
            .get(decision.id) as { content_original: string | null; classification: number; encrypted: number; sealed_format_version: number; evidence: string };
          if (after.content_original !== row.content_original || after.classification !== row.classification ||
            after.encrypted !== row.encrypted || after.sealed_format_version !== row.sealed_format_version || after.evidence !== row.evidence) {
            throw new Error(`durable ${decision.id} sealed payload changed during re-own`);
          }
          reowned.push({ kind: "durable", id: decision.id });
        } else {
          const row = db.prepare("SELECT id, user_id, evidence_excerpts FROM short_term_memories WHERE id = ?").get(decision.id) as
            | { id: number; user_id: string; evidence_excerpts: string } | undefined;
          if (!row || row.user_id !== decision.sourceOwner) throw new Error(`episode ${decision.id} changed before apply — re-inspect`);
          if (row.user_id === primaryOwner) throw new Error(`episode ${decision.id} is already primary-owned`);
          const linked = (db.prepare("SELECT COUNT(*) AS c FROM personal_grouping_ledger WHERE episode_id = ?").get(decision.id) as { c: number }).c;
          if (linked > 0) throw new Error(`episode ${decision.id} carries grouping-ledger links that re-own cannot preserve`);
          const marked = (db.prepare("SELECT COUNT(*) AS c FROM forget_markers WHERE record_kind = 'episode' AND record_id = ?").get(decision.id) as { c: number }).c;
          if (marked > 0) throw new Error(`episode ${decision.id} carries forgetting markers`);
          const result = db.prepare("UPDATE short_term_memories SET user_id = ? WHERE id = ? AND user_id = ?")
            .run(primaryOwner, decision.id, decision.sourceOwner);
          if (result.changes !== 1) throw new Error(`episode ${decision.id} re-own affected ${result.changes} rows`);
          reowned.push({ kind: "episode", id: decision.id });
        }
      }
    })();
  } catch (err) {
    return { ok: false, refused: err instanceof Error ? err.message : "re-own interrupted" };
  }
  // Exact replay: rows already primary-owned with matching reownedFrom are
  // reported as skipped without writes.
  return { ok: true, reowned, skipped: [] };
}

function isReplayedReown(db: Database.Database, d: ReownDecision, primaryOwner: string): boolean {
  if (d.kind !== "durable" || typeof d.rationale !== "string" || !d.rationale.trim()) return false;
  const row = db.prepare("SELECT user_id, revision, provenance FROM long_term_memories WHERE id = ?").get(d.id) as
    | { user_id: string; revision: number; provenance: string } | undefined;
  if (!row || row.user_id !== primaryOwner || row.revision !== d.expectedRevision) return false;
  try {
    const parsed = JSON.parse(row.provenance) as { reownedFrom?: { owner?: unknown; revision?: unknown } };
    return parsed.reownedFrom?.owner === d.sourceOwner && parsed.reownedFrom?.revision === d.expectedRevision;
  } catch {
    return false;
  }
}

function mergeReownedFrom(provenance: string, from: string, revision: number, to: string, rationale: string): string {
  let base: Record<string, unknown>;
  try {
    base = JSON.parse(provenance) as Record<string, unknown>;
    if (!base || typeof base !== "object" || Array.isArray(base)) base = {};
  } catch {
    base = {};
  }
  return JSON.stringify({
    ...base,
    reownedFrom: { owner: from, revision, to, rationale, at: Date.now() },
  });
}
