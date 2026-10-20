/**
 * sleep-data-access.ts — Database queries used by the sleep cycle.
 * Lives in the memory package so it can use raw DB internally.
 * Sleep imports this via IMemorySystem.getSleepData().
 */

import type Database from "better-sqlite3";
import { requirePrimaryUserId, assertPrimaryMemoryOwner, assertSnapshotOwner } from "./user-utils.js";
import { CONSUMED_SESSION_SQL } from "./sleep/coverage.js";
import { isPersonalReady } from "./personal-schema.js";
import { servingGeneration } from "./recall-projection-build.js";
import { isSuppressedByForget } from "./personal-forget.js";
import { selectPrunableMessageIds } from "./personal-retention.js";

/** Durable eligibility for sleep (matches the #1928 projection eligibility):
 *  run owner, current (superseded_by_id IS NULL, not past valid_to),
 *  classification <= 2, not encrypted/sealed, not forget-suppressed. */
function durableEligibilitySql(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  return `${p}superseded_by_id IS NULL AND ${p}classification <= 2 AND ${p}encrypted = 0 AND ${p}sealed_format_version = 0 AND (${p}valid_to IS NULL OR ${p}valid_to > strftime('%Y-%m-%d','now','localtime'))`;
}

function suppressed(db: Database.Database, owner: string, durableId: number): boolean {
  try {
    return isSuppressedByForget(db, owner, { durableId });
  } catch {
    // Fail closed: when markers exist but key material is unavailable the
    // check throws — a possibly-forgotten durable is never served as sleep
    // evidence.
    return true;
  }
}

export class SleepDataAccess {
  constructor(
    private readonly db: Database.Database,
    private readonly ownerSnapshot?: string | null,
  ) {
  }

  /** Transitional: expose raw DB for callers not yet migrated (buildDailySummary). */
  getDb(): Database.Database { return this.db; }

  /** #1863 Step 0: the startup snapshot when the owner supplied one, else
   * the legacy ambient resolution (isolated tests without a manifest). */
  getPrimaryUserId(): string {
    return this.ownerSnapshot ?? requirePrimaryUserId();
  }

  getOwnerSnapshot(): string | null {
    return this.ownerSnapshot ?? null;
  }

  /**
   * #1863: assert a run principal before any sleep artifact or memory write.
   * Compares against the startup snapshot when present (a non-master run
   * never reaches the write, including the supersede-delete path); legacy
   * ambient check otherwise. Throws PrimaryIdentityError on mismatch.
   */
  assertWritePrincipal(userId: string): void {
    if (this.ownerSnapshot != null) assertSnapshotOwner(userId, this.ownerSnapshot);
    else assertPrimaryMemoryOwner(userId);
  }

  getExtractionWatermark(userId: string): number {
    const row = this.db.prepare("SELECT last_processed_timestamp FROM extraction_watermarks WHERE user_id = ?").get(userId) as { last_processed_timestamp: number } | undefined;
    return row?.last_processed_timestamp ?? 0;
  }

  /**
   * Advance one principal's extraction watermark to `throughTs` (#1860).
   * Monotonic: a lower value never regresses an existing watermark (#1603).
   *
   * Sleep reads primary-only, so only the consumed principal advances. The
   * old `SELECT DISTINCT user_id` fan-out marked every principal processed
   * without reading them; other principals keep their watermark and their
   * retention is no longer decided by sleep.
   */
  advanceExtractionWatermarks(throughTs: number, userId: string): number {
    this.db.prepare(
      `INSERT INTO extraction_watermarks (user_id, last_processed_timestamp) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET last_processed_timestamp =
         MAX(extraction_watermarks.last_processed_timestamp, excluded.last_processed_timestamp)`,
    ).run(userId, throughTs);
    return 1;
  }

  getMessagesAfter(afterTs: number, userId?: string): Array<{ id: number; role: string; content: string; emotion_score: number | null; timestamp: number }> {
    const userFilter = userId ? " AND user_id = ?" : "";
    const params: unknown[] = userId ? [afterTs, userId] : [afterTs];
    return this.db.prepare(
      `SELECT id, role, content, emotion_score, timestamp FROM messages WHERE timestamp > ?${userFilter} AND (session_id LIKE '%\\_A\\_%' ESCAPE '\\' OR session_id LIKE '%\\_C\\_%' ESCAPE '\\' OR session_id = '' OR session_id NOT LIKE '%\\_%\\_%' ESCAPE '\\') ORDER BY timestamp`,
    ).all(...params) as Array<{ id: number; role: string; content: string; emotion_score: number | null; timestamp: number }>;
  }

  getShortMessageCount(): number {
    return (this.db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE role='user' AND length(content) < 20").get() as { cnt: number }).cnt;
  }

  deleteMessagesByIds(ids: number[]): void {
    if (ids.length === 0) return;
    this.db.prepare(`DELETE FROM messages WHERE id IN (${ids.join(",")})`).run();
  }

  /**
   * Age alone never authorizes deletion (#1603). Consumed rows can be pruned
   * only for the current primary and only through this run's proven coverage
   * ceiling (#1860); existing watermarks may predate the claim ledger or have
   * been advanced for another principal. `[SYSTEM` rows remain an explicit
   * content-based exclusion. Other principals and session types are retained.
   *
   * #1930 C3: every automatic deletion route enforces the single
   * coverage/evidence-aware owner predicate. Personal automatic pruning is
   * refused until verified readiness; eligible deletions are restricted to
   * exchange-prunable message ids so required excerpts and downstream
   * episode/durable writes stay durable and sole surviving evidence is
   * never removed.
   */
  flushOldMessages(opts: {
    maxAgeDays: number;
    maxCount: number;
    userId: string;
    coveredThroughTs: number | null;
    /** Test override for the ~1,000-exchange rolling target. */
    targetExchanges?: number;
  }): { agedOut: number; capped: number } {
    // Fail-closed until verified readiness: refuse automatic pruning.
    try {
      if (!isPersonalReady(this.db)) return { agedOut: 0, capped: 0 };
    } catch {
      // When readiness bookkeeping predates this database, retain.
      return { agedOut: 0, capped: 0 };
    }
    // Exchange-prunable set bounds personal deletions below: required
    // excerpts, committed downstream writes and sole-evidence protection hold
    // even when the age/count sweep would otherwise delete more. Transient
    // [SYSTEM rows are an explicit content-based exclusion and delete below
    // the watermark independent of the exchange budget.
    let prunable: Set<number> = new Set();
    try {
      const selected = selectPrunableMessageIds(this.db, opts.userId, { coveredThroughTs: opts.coveredThroughTs, targetExchanges: opts.targetExchanges });
      prunable = new Set(selected.messageIds);
    } catch {
      prunable = new Set();
    }
    const prunableIds = [...prunable];
    const ageCutoff = Date.now() - opts.maxAgeDays * 86400000;
    const watermarkGuard = `timestamp <= COALESCE(
      (SELECT w.last_processed_timestamp FROM extraction_watermarks w WHERE w.user_id = messages.user_id), 0)`;
    const coveredGuard = opts.coveredThroughTs === null
      ? "0"
      : `(user_id = ? AND timestamp <= ? AND ${watermarkGuard} AND ${CONSUMED_SESSION_SQL})`;
    const systemExclusionGuard = `(content LIKE '[SYSTEM%' AND ${watermarkGuard})`;
    const claimGuard = `(${coveredGuard} OR ${systemExclusionGuard})`;
    const claimParams = opts.coveredThroughTs === null ? [] : [opts.userId, opts.coveredThroughTs];
    let agedOut = 0;
    if (prunableIds.length > 0) {
      const prunablePlaceholders = prunableIds.map(() => "?").join(",");
      agedOut += this.db.prepare(
        `DELETE FROM messages WHERE timestamp < ? AND id IN (${prunablePlaceholders}) AND ${claimGuard}`,
      ).run(ageCutoff, ...prunableIds, ...claimParams).changes;
    }
    // Transient SYSTEM rows below the watermark delete independent of budget.
    agedOut += this.db.prepare(
      `DELETE FROM messages WHERE timestamp < ? AND ${systemExclusionGuard}`,
    ).run(ageCutoff).changes;
    const total = (this.db.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c;
    let capped = 0;
    if (total > opts.maxCount && prunableIds.length > 0) {
      const prunablePlaceholders = prunableIds.map(() => "?").join(",");
      capped = this.db.prepare(
        `DELETE FROM messages WHERE id IN (
           SELECT id FROM messages WHERE id IN (${prunablePlaceholders}) AND ${claimGuard} ORDER BY timestamp ASC LIMIT ?
         )`,
      ).run(...prunableIds, ...claimParams, total - opts.maxCount).changes;
    }
    return { agedOut, capped };
  }

  // ── #1937 new-model-only sleep readers ───────────────────────────────────
  // Every read below is scoped to the caller's primaryUserId and to eligible
  // durables only (owner, current, classification <= 2, not encrypted/sealed,
  // not forget-suppressed). No extracted_memories, legacy FTS, or entity_graph
  // access remains in the sleep path.

  /** Eligible durables created or revised since `sinceTs` (step-05 evidence),
   *  excluding observations. Ordered newest first, bounded. */
  getContradictionEvidence(
    userId: string,
    sinceTs: number,
  ): Array<{ id: number; content: string; memory_type: string; revision: number }> {
    let rows: Array<{ id: number; content: string; memory_type: string; revision: number; created_at: number; updated_at: number }>;
    try {
      rows = this.db.prepare(
        `SELECT id, content, memory_type, revision, created_at, updated_at
         FROM long_term_memories
         WHERE user_id = ? AND ${durableEligibilitySql()} AND memory_type != 'observation'
           AND (created_at >= ? OR updated_at >= ?)
         ORDER BY updated_at DESC, created_at DESC LIMIT 30`,
      ).all(userId, sinceTs, sinceTs) as typeof rows;
    } catch {
      return [];
    }
    return rows.filter((r) => !suppressed(this.db, userId, r.id));
  }

  /** Other eligible durables found through the #1928 serving lexical
   *  projection, excluding one evidence row. Empty when no generation serves. */
  getContradictionCandidates(
    userId: string,
    keywords: string,
    excludeId: number,
    limit = 5,
  ): Array<{ id: number; content: string; memory_type: string; revision: number }> {
    const bounded = Math.max(1, Math.min(limit, 20));
    let gen: number | null = null;
    try {
      gen = servingGeneration(this.db);
    } catch {
      return [];
    }
    if (gen === null) return [];
    if (!keywords.trim()) return [];
    let recordIds: number[];
    try {
      const docs = this.db.prepare(
        `SELECT d.record_id AS recordId FROM recall_fts ft
         JOIN recall_documents d ON d.id = ft.rowid
         WHERE recall_fts MATCH ? AND d.owner = ? AND d.generation = ?
           AND d.layer = 'durable' AND d.classification <= 2 AND d.record_id != ?
         ORDER BY rank LIMIT ?`,
      ).all(keywords, userId, gen, excludeId, bounded) as Array<{ recordId: number }>;
      recordIds = docs.map((d) => d.recordId).filter((n) => Number.isSafeInteger(n) && n >= 1);
    } catch {
      return [];
    }
    if (recordIds.length === 0) return [];
    const placeholders = recordIds.map(() => "?").join(",");
    let rows: Array<{ id: number; content: string; memory_type: string; revision: number }>;
    try {
      rows = this.db.prepare(
        `SELECT id, content, memory_type, revision FROM long_term_memories
         WHERE user_id = ? AND ${durableEligibilitySql()} AND memory_type != 'observation'
           AND id IN (${placeholders})`,
      ).all(userId, ...recordIds) as typeof rows;
    } catch {
      return [];
    }
    const byId = new Map(rows.filter((r) => !suppressed(this.db, userId, r.id)).map((r) => [r.id, r]));
    // Preserve projection rank order.
    const out: typeof rows = [];
    for (const id of recordIds) {
      const r = byId.get(id);
      if (r && out.length < bounded) out.push(r);
    }
    return out;
  }

  /** Current-run attribution: eligible durable ids in the run window. */
  getCurrentRunNewIds(userId: string, fromTs: number, toTs: number, ids: readonly number[]): number[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    let rows: Array<{ id: number; created_at: number; updated_at: number }>;
    try {
      rows = this.db.prepare(
        `SELECT id, created_at, updated_at FROM long_term_memories
         WHERE user_id = ? AND ${durableEligibilitySql()} AND memory_type != 'observation'
           AND (created_at >= ? AND created_at <= ? OR updated_at >= ? AND updated_at <= ?)
           AND id IN (${placeholders})`,
      ).all(userId, fromTs, toTs, fromTs, toTs, ...ids) as typeof rows;
    } catch {
      return [];
    }
    return rows.filter((r) => !suppressed(this.db, userId, r.id)).map((row) => row.id);
  }

  /** REM synthesis sample — eligible durables, excluding observations. */
  getRemSample(userId: string, limit: number): Array<{ id: number; content: string; memory_type: string; created_at: number }> {
    let rows: Array<{ id: number; content: string; memory_type: string; created_at: number }>;
    try {
      rows = this.db.prepare(
        `SELECT id, content, memory_type, created_at FROM long_term_memories
         WHERE user_id = ? AND ${durableEligibilitySql()} AND memory_type != 'observation'
         ORDER BY RANDOM() LIMIT ${Math.max(1, Math.min(limit, 50))}`,
      ).all(userId) as typeof rows;
    } catch {
      return [];
    }
    return rows.filter((r) => !suppressed(this.db, userId, r.id));
  }

  /** Owner-scoped durable pair read for ask-candidate evaluation. */
  getEvidencePair(userId: string, ids: readonly number[]): Array<{ id: number; valid_to: string | null; classification: number; revision: number }> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    try {
      return this.db.prepare(
        `SELECT id, valid_to, classification, revision FROM long_term_memories
         WHERE id IN (${placeholders}) AND user_id = ?`,
      ).all(...ids, userId) as Array<{ id: number; valid_to: string | null; classification: number; revision: number }>;
    } catch {
      return [];
    }
  }

  /** Eligible durable count for the owner (snapshot/audit/eligibility). */
  getDurableCount(userId: string): number {
    try {
      const row = this.db.prepare(
        `SELECT COUNT(*) AS c FROM long_term_memories WHERE user_id = ? AND ${durableEligibilitySql()}`,
      ).get(userId) as { c: number };
      const all = this.db.prepare(
        `SELECT id FROM long_term_memories WHERE user_id = ? AND ${durableEligibilitySql()} LIMIT 5000`,
      ).all(userId) as Array<{ id: number }>;
      let count = 0;
      for (const r of all) {
        if (!suppressed(this.db, userId, r.id)) count++;
      }
      void row;
      return count;
    } catch {
      return 0;
    }
  }
  // ── #1930 M2: Dreamy topic grouping + selective durable promotion ──
  // Grouping and promotion run through the host-supplied sleep runtime; abmind
  // owns deterministic validation, writes, settlement and retention. The
  // production seam is settleSleepProposals() in personal-sleep.ts, called by
  // the sleep levels (basic/native); the single writer is
  // PrivateMemoryMutationStore.
}
