import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * dream-question-store.ts — #1515 durable Dreamy clarification questions.
 *
 * Owns the `dream_questions` SQLite table lifecycle: owner-scoped inserts,
 * bounded reads, single-row CAS mutations, reconciliation (evidence
 * disappearance/invalidation/revision change -> resolved; seven-day expiry),
 * and 30-day terminal retention. No memory content is ever stored; the table
 * holds only question text plus canonical evidence IDs and captured revisions.
 *
 * Every read and mutation predicates on `user_id`; possession of a question
 * ID is not authority. Owner mismatch is indistinguishable from not found.
 */

export type DreamQuestionStatus =
  | "pending" | "asked" | "resolved" | "expired" | "dismissed";

/** Raw SQLite row shape (snake_case columns). */
interface DreamQuestionDbRow {
  id: string;
  memory_a_id: number;
  memory_b_id: number;
  question: string;
  status: DreamQuestionStatus;
  created_at: number;
  expires_at: number;
  asked_at: number | null;
}

export interface StoredDreamQuestionProjection {
  id: string;
  userId: string;
  memoryAId: number;
  memoryBId: number;
  question: string;
  status: DreamQuestionStatus;
  createdAt: number;
  expiresAt: number;
  askedAt?: number;
}

/** Wire projection — omits userId (every call is already owner-scoped), never
 *  returns memory content or captured revisions. */
export interface DreamQuestionWireProjection {
  id: string;
  memoryAId: number;
  memoryBId: number;
  question: string;
  status: DreamQuestionStatus;
  createdAt: number;
  expiresAt: number;
  askedAt?: number;
}

export type NextPendingResult = DreamQuestionWireProjection | null;
export type ListResult = { questions: DreamQuestionWireProjection[] };
export type MarkAskedResult = { status: "asked" | "not_found" | "conflict" };
export type DismissResult = {
  status: "dismissed" | "not_found" | "already_terminal";
};

export interface InsertCandidateInput {
  userId: string;
  memoryAId: number;
  memoryBId: number;
  memoryARevision: number;
  memoryBRevision: number;
  question: string;
  sourceRunId: string;
}

export type InsertCandidateResult =
  | { accepted: true; id: string }
  | { accepted: false; reason: "active_pair" | "recent_asked_or_dismissed" | "global_cap" | "duplicate" };

export interface DreamQuestionStoreOptions {
  /** Injected clock — every timestamp derives from it. */
  now?: () => number;
  /** Injected opaque ID generator. */
  idGen?: () => string;
}

export const ACTIVE_QUESTION_GLOBAL_CAP = 20;
export const PAIR_DEDUPE_WINDOW_MS = 7 * 24 * 3600_000;
export const TERMINAL_RETENTION_MS = 30 * 24 * 3600_000;
export const LIST_DEFAULT_LIMIT = 20;
export const LIST_MAX_LIMIT = 50;

export class DreamQuestionStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly idGen: () => string;

  constructor(db: Database.Database, options?: DreamQuestionStoreOptions) {
    this.db = db;
    this.now = options?.now ?? Date.now;
    this.idGen = options?.idGen ?? randomUUID;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Transactional candidate acceptance: reconcile, enforce the active-pair
   * and recent-asked/dismissed windows, enforce the global active cap, and
   * insert one pending row. A partial-unique-index conflict is a
   * deterministic duplicate drop, never a failure.
   */
  insertCandidate(input: InsertCandidateInput): InsertCandidateResult {
    const now = this.now();
    const insert = this.db.transaction((): InsertCandidateResult => {
      this.reconcileUser(input.userId, now);

      // The cap is global, so reconcile every owner that currently has an
      // active row before counting.  Under the cap this is a small bounded
      // set; without this pass a stale row belonging to another owner could
      // permanently consume one of the global slots.
      const activeOwners = this.db.prepare(
        `SELECT DISTINCT user_id FROM dream_questions
         WHERE status IN ('pending','asked')`,
      ).all() as Array<{ user_id: string }>;
      for (const owner of activeOwners) {
        if (owner.user_id !== input.userId) this.reconcileUser(owner.user_id, now);
      }

      const active = this.db.prepare(
        `SELECT id FROM dream_questions
         WHERE user_id = ? AND memory_a_id = ? AND memory_b_id = ?
           AND status IN ('pending','asked')`,
      ).get(input.userId, input.memoryAId, input.memoryBId);
      if (active) return { accepted: false, reason: "active_pair" };

      const recent = this.db.prepare(
        `SELECT MAX(asked_at) AS asked, MAX(dismissed_at) AS dismissed
         FROM dream_questions
         WHERE user_id = ? AND memory_a_id = ? AND memory_b_id = ?`,
      ).get(input.userId, input.memoryAId, input.memoryBId) as { asked: number | null; dismissed: number | null };
      const recentTs = Math.max(recent?.asked ?? 0, recent?.dismissed ?? 0);
      if (recentTs > 0 && now - recentTs < PAIR_DEDUPE_WINDOW_MS) {
        return { accepted: false, reason: "recent_asked_or_dismissed" };
      }

      const activeCount = this.db.prepare(
        `SELECT COUNT(*) AS c FROM dream_questions WHERE status IN ('pending','asked')`,
      ).get() as { c: number };
      if (activeCount.c >= ACTIVE_QUESTION_GLOBAL_CAP) {
        return { accepted: false, reason: "global_cap" };
      }

      const id = this.idGen();
      try {
        this.db.prepare(
          `INSERT INTO dream_questions
            (id, user_id, memory_a_id, memory_b_id, memory_a_revision, memory_b_revision,
             question, status, source_run_id, source_step, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'contradiction-and-graph', ?, ?)`,
        ).run(
          id, input.userId, input.memoryAId, input.memoryBId,
          input.memoryARevision, input.memoryBRevision,
          input.question, input.sourceRunId, now, now + 7 * 24 * 3600_000,
        );
        return { accepted: true, id };
      } catch {
        return { accepted: false, reason: "duplicate" };
      }
    });
    // Acquire the write reservation before reading/reconciling the global
    // active set.  A deferred transaction could let two writers both observe
    // a free slot and exceed the global cap before either INSERT commits.
    return insert.immediate();
  }

  /**
   * Oldest eligible pending question (then lowest id) for the owner, after
   * reconciliation. Null when none exist.
   */
  nextPending(userId: string): NextPendingResult {
    const now = this.now();
    return this.db.transaction((): NextPendingResult => {
      this.reconcileUser(userId, now);
      const row = this.db.prepare(
        `SELECT id, memory_a_id, memory_b_id, question, status, created_at, expires_at, asked_at
         FROM dream_questions
         WHERE user_id = ? AND status = 'pending'
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
      ).get(userId) as DreamQuestionDbRow | undefined;
      return row ? this.toWire(row) : null;
    })();
  }

  /**
   * Bounded owner-scoped list. Defaults to active rows (pending/asked) ordered
   * by creation time then id; an optional single lifecycle status filter is
   * applied when given. limit is clamped to the documented range.
   */
  list(userId: string, status?: DreamQuestionStatus, limit?: number): ListResult {
    const now = this.now();
    return this.db.transaction((): ListResult => {
      this.reconcileUser(userId, now);
      const bounded = Math.max(1, Math.min(LIST_MAX_LIMIT, Math.floor(limit ?? LIST_DEFAULT_LIMIT)));
      const rows = status
        ? this.db.prepare(
            `SELECT id, memory_a_id, memory_b_id, question, status, created_at, expires_at, asked_at
             FROM dream_questions WHERE user_id = ? AND status = ?
             ORDER BY created_at ASC, id ASC LIMIT ?`,
          ).all(userId, status, bounded) as DreamQuestionDbRow[]
        : this.db.prepare(
            `SELECT id, memory_a_id, memory_b_id, question, status, created_at, expires_at, asked_at
             FROM dream_questions WHERE user_id = ? AND status IN ('pending','asked')
             ORDER BY created_at ASC, id ASC LIMIT ?`,
          ).all(userId, bounded) as DreamQuestionDbRow[];
      return { questions: rows.map(r => this.toWire(r)) };
    })();
  }

  /**
   * Owner-scoped `pending -> asked` CAS with a delivery key. Success only when
   * the row transitions or is already asked with the identical delivery key.
   * Owner mismatch is indistinguishable from not found.
   */
  markAsked(userId: string, id: string, deliveryKey: string): MarkAskedResult {
    const now = this.now();
    return this.db.transaction((): MarkAskedResult => {
      this.reconcileUser(userId, now);
      const result = this.db.prepare(
        `UPDATE dream_questions SET status = 'asked', asked_at = ?, delivery_key = ?
         WHERE id = ? AND user_id = ? AND status = 'pending'`,
      ).run(now, deliveryKey, id, userId);
      if (result.changes === 1) return { status: "asked" };

      const row = this.db.prepare(
        `SELECT status, delivery_key FROM dream_questions WHERE id = ? AND user_id = ?`,
      ).get(id, userId) as { status: DreamQuestionStatus; delivery_key: string | null } | undefined;
      if (!row) return { status: "not_found" };
      if (row.status === "asked" && row.delivery_key === deliveryKey) return { status: "asked" };
      return { status: "conflict" };
    })();
  }

  /**
   * Owner-scoped `pending|asked -> dismissed` CAS. Preserves existing
   * asked/delivery fields where present. Already-terminal rows (owner-scoped)
   * return already_terminal; a new request cannot un-dismiss.
   */
  dismiss(userId: string, id: string): DismissResult {
    const now = this.now();
    return this.db.transaction((): DismissResult => {
      this.reconcileUser(userId, now);
      const result = this.db.prepare(
        `UPDATE dream_questions SET status = 'dismissed', dismissed_at = ?
         WHERE id = ? AND user_id = ? AND status IN ('pending','asked')`,
      ).run(now, id, userId);
      if (result.changes === 1) return { status: "dismissed" };

      const row = this.db.prepare(
        `SELECT status FROM dream_questions WHERE id = ? AND user_id = ?`,
      ).get(id, userId) as { status: DreamQuestionStatus } | undefined;
      if (!row) return { status: "not_found" };
      return { status: "already_terminal" };
    })();
  }

  /**
   * Idempotent reconciliation for the owner's bounded active rows:
   * 1. resolve rows whose evidence disappeared, was invalidated, changed
   *    owner, left classification < 3, or changed semantic revision;
   * 2. expire remaining active rows past expires_at;
   * 3. prune terminal rows older than 30 days.
   * Precedence: resolved before expired. Terminal rows are immutable.
   */
  reconcileUser(userId: string, now: number): void {
    const activeRows = this.db.prepare(
      `SELECT id, memory_a_id, memory_b_id, memory_a_revision, memory_b_revision, expires_at, status
       FROM dream_questions
       WHERE user_id = ? AND status IN ('pending','asked')`,
    ).all(userId) as Array<{
      id: string; memory_a_id: number; memory_b_id: number;
      memory_a_revision: number; memory_b_revision: number;
      expires_at: number; status: DreamQuestionStatus;
    }>;

    for (const row of activeRows) {
      const evidence = this.db.prepare(
        `SELECT user_id, valid_to, classification, semantic_revision
         FROM extracted_memories WHERE id = ?`,
      ).get(row.memory_a_id) as { user_id: string; valid_to: string | null; classification: number; semantic_revision: number } | undefined;
      const evidenceB = this.db.prepare(
        `SELECT user_id, valid_to, classification, semantic_revision
         FROM extracted_memories WHERE id = ?`,
      ).get(row.memory_b_id) as { user_id: string; valid_to: string | null; classification: number; semantic_revision: number } | undefined;

      const invalidA = this.evidenceInvalid(row.memory_a_id, evidence, userId, row.memory_a_revision);
      const invalidB = this.evidenceInvalid(row.memory_b_id, evidenceB, userId, row.memory_b_revision);
      if (invalidA || invalidB) {
        this.db.prepare(
          `UPDATE dream_questions SET status = 'resolved', resolved_at = ?
           WHERE id = ? AND user_id = ? AND status IN ('pending','asked')`,
        ).run(now, row.id, userId);
        continue;
      }
      if (row.expires_at <= now) {
        this.db.prepare(
          `UPDATE dream_questions SET status = 'expired'
           WHERE id = ? AND user_id = ? AND status IN ('pending','asked')`,
        ).run(row.id, userId);
      }
    }

    const cutoff = now - TERMINAL_RETENTION_MS;
    this.db.prepare(
      `DELETE FROM dream_questions
       WHERE user_id = ? AND status = 'resolved' AND resolved_at < ?`,
    ).run(userId, cutoff);
    this.db.prepare(
      `DELETE FROM dream_questions
       WHERE user_id = ? AND status = 'expired' AND expires_at < ?`,
    ).run(userId, cutoff);
    this.db.prepare(
      `DELETE FROM dream_questions
       WHERE user_id = ? AND status = 'dismissed' AND dismissed_at < ?`,
    ).run(userId, cutoff);
    this.db.prepare(
      `DELETE FROM dream_questions
       WHERE user_id = ? AND status = 'asked' AND asked_at < ?`,
    ).run(userId, cutoff);
  }

  private evidenceInvalid(
    memoryId: number,
    row: { user_id: string; valid_to: string | null; classification: number; semantic_revision: number } | undefined,
    userId: string,
    capturedRevision: number,
  ): boolean {
    if (!row) return true;
    if (row.user_id !== userId) return true;
    if (row.valid_to !== null) return true;
    if (row.classification >= 3) return true;
    return row.semantic_revision !== capturedRevision;
  }

  private toWire(row: DreamQuestionDbRow): DreamQuestionWireProjection {
    const wire: DreamQuestionWireProjection = {
      id: row.id,
      memoryAId: row.memory_a_id,
      memoryBId: row.memory_b_id,
      question: row.question,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
    if (row.asked_at != null) wire.askedAt = row.asked_at;
    return wire;
  }
}
