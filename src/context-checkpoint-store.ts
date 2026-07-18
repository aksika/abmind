/**
 * context-checkpoint-store.ts — Cumulative checkpoint lineage for cache-stable
 * context assembly (#1335).
 *
 * Provides append-only checkpoint records with a generation-guarded active
 * pointer. One active cumulative checkpoint per session; historical checkpoints
 * remain as append-only provenance but are not injected into context.
 *
 * Every added column has a writer, reader, and round-trip test.
 */

import type Database from "better-sqlite3";
import { CHARS_PER_TOKEN } from "./context-engine.js";

const TAG = "context-checkpoint";

// ── types ────────────────────────────────────────────────────────────────────

export interface CheckpointRecord {
  id: number;
  chatId: string;
  previousCheckpointId: number | null;
  sourceMessageStart: number;
  sourceMessageEnd: number;
  firstKeptMessageId: number;
  content: string;
  sourceTokenCount: number;
  checkpointTokenCount: number;
  sourceDigest: string;
  checkpointDigest: string;
  summarizerModel: string | null;
  summarizerProvider: string | null;
  activeRequestModel: string;
  reason: string;
  budgetJson: string;
  classification: number;
  promptVersion: string;
  schemaVersion: number;
  serializerVersion: string;
  createdAt: number;
}

export interface ActiveCheckpointPointer {
  chatId: string;
  checkpointId: number;
  generation: number;
  updatedAt: number;
}

export interface StableContextBudget {
  maxHistoryTokens: number;
  minRecentTokens: number;
  reason: "headroom" | "fallback_model" | "manual" | "reactive_overflow";
  activeModel: string;
  estimatorVersion: string;
}

export interface StableContextView {
  checkpoint?: {
    id: number;
    content: string;
    digest: string;
    firstKeptMessageId: number;
    generation: number;
  };
  messages: Array<{ id: number; role: string; content: string }>;
  estimatedTokens: number;
  stablePrefixDigest: string;
  rendererVersion: string;
}

// ── schema helpers ───────────────────────────────────────────────────────────

const CHECKPOINT_TABLE = "context_checkpoints";
const ACTIVE_POINTER_TABLE = "active_context_checkpoint";
const SCHEMA_VERSION = 1;

export const CHECKPOINT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ${CHECKPOINT_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    previous_checkpoint_id INTEGER,
    source_message_start INTEGER NOT NULL,
    source_message_end INTEGER NOT NULL,
    first_kept_message_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    source_token_count INTEGER NOT NULL,
    checkpoint_token_count INTEGER NOT NULL,
    source_digest TEXT NOT NULL,
    checkpoint_digest TEXT NOT NULL,
    summarizer_model TEXT,
    summarizer_provider TEXT,
    active_request_model TEXT NOT NULL,
    reason TEXT NOT NULL,
    budget_json TEXT NOT NULL,
    classification INTEGER NOT NULL,
    prompt_version TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    serializer_version TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_checkpoints_chat ON ${CHECKPOINT_TABLE}(chat_id, created_at);

  CREATE TABLE IF NOT EXISTS ${ACTIVE_POINTER_TABLE} (
    chat_id TEXT PRIMARY KEY,
    checkpoint_id INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

// ── CheckpointStore ──────────────────────────────────────────────────────────

export class CheckpointStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Get the active checkpoint pointer for a session, or null. */
  getActivePointer(chatId: string): ActiveCheckpointPointer | null {
    const row = this.db.prepare(
      `SELECT * FROM ${ACTIVE_POINTER_TABLE} WHERE chat_id = ?`,
    ).get(chatId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      chatId: row.chat_id as string,
      checkpointId: row.checkpoint_id as number,
      generation: row.generation as number,
      updatedAt: row.updated_at as number,
    };
  }

  /** Get a single checkpoint record by ID. */
  getCheckpoint(checkpointId: number): CheckpointRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM ${CHECKPOINT_TABLE} WHERE id = ?`,
    ).get(checkpointId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToRecord(row);
  }

  /** Get checkpoints for a session, newest first. */
  getCheckpoints(chatId: string, limit = 10): CheckpointRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM ${CHECKPOINT_TABLE} WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?`,
    ).all(chatId, limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToRecord(r));
  }

  /**
   * Atomically insert a new checkpoint and CAS-update the active pointer.
   * Returns the new checkpoint ID, or -1 if generation is stale (CAS miss).
   */
  commitCheckpoint(
    chatId: string,
    record: Omit<CheckpointRecord, "id" | "createdAt" | "chatId">,
    expectedGeneration: number,
  ): number {
    const txn = this.db.transaction(() => {
      // CAS: verify generation hasn't changed.
      // The absent-pointer state is generation 0. A commit that observed an
      // absent pointer must pass expectedGeneration === 0; a commit that
      // observed an existing pointer must pass that exact generation. The
      // first commit advances the pointer to generation 1 so that a second
      // writer which also observed the absent state (expectedGeneration 0)
      // is stale and rejected — it can no longer match the now-present
      // pointer. See #1335 finding #4.
      const current = this.getActivePointer(chatId);
      if (current) {
        if (current.generation !== expectedGeneration) return -1;
      } else if (expectedGeneration !== 0) {
        // Pointer absent but caller expected a non-zero generation → stale.
        return -1;
      }

      // Insert checkpoint record
      const stmt = this.db.prepare(`
        INSERT INTO ${CHECKPOINT_TABLE}
          (chat_id, previous_checkpoint_id, source_message_start, source_message_end,
           first_kept_message_id, content, source_token_count, checkpoint_token_count,
           source_digest, checkpoint_digest, summarizer_model, summarizer_provider,
           active_request_model, reason, budget_json, classification,
           prompt_version, schema_version, serializer_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        chatId,
        record.previousCheckpointId,
        record.sourceMessageStart,
        record.sourceMessageEnd,
        record.firstKeptMessageId,
        record.content,
        record.sourceTokenCount,
        record.checkpointTokenCount,
        record.sourceDigest,
        record.checkpointDigest,
        record.summarizerModel,
        record.summarizerProvider,
        record.activeRequestModel,
        record.reason,
        record.budgetJson,
        record.classification,
        record.promptVersion,
        record.schemaVersion,
        record.serializerVersion,
        Date.now(),
      );
      const newId = Number(result.lastInsertRowid);

      // CAS-update active pointer. Generation always advances by one from
      // the observed value, so the first commit (expectedGeneration 0 → 1)
      // cannot be matched by a stale concurrent expected-zero writer.
      const newGeneration = expectedGeneration + 1;
      this.db.prepare(`
        INSERT INTO ${ACTIVE_POINTER_TABLE} (chat_id, checkpoint_id, generation, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          checkpoint_id = excluded.checkpoint_id,
          generation = excluded.generation,
          updated_at = excluded.updated_at
      `).run(chatId, newId, newGeneration, Date.now());

      return newId;
    });
    return txn();
  }

  /**
   * Read-only stable context view: one active cumulative checkpoint plus
   * contiguous verbatim suffix bounded by the cursor.
   *
   * Invariant:
   *   activeCheckpoint.firstKeptMessageId <= rawMessage.id < beforeMessageId
   */
  getStableContext(
    chatId: string,
    messages: Array<{ id: number; role: string; content: string }>,
    options?: { beforeMessageId?: number },
  ): StableContextView {
    const activePtr = this.getActivePointer(chatId);
    let checkpoint: StableContextView["checkpoint"];
    let checkpointFirstKept = 0;

    if (activePtr) {
      const cp = this.getCheckpoint(activePtr.checkpointId);
      if (cp) {
        checkpoint = {
          id: cp.id,
          content: cp.content,
          digest: cp.checkpointDigest,
          firstKeptMessageId: cp.firstKeptMessageId,
          generation: activePtr.generation,
        };
        checkpointFirstKept = cp.firstKeptMessageId;
      }
    }

    // Filter messages to the suffix: firstKeptMessageId <= id < beforeMessageId
    const upperId = options?.beforeMessageId ?? Number.MAX_SAFE_INTEGER;
    const suffixMessages = messages.filter(m =>
      m.id >= checkpointFirstKept && m.id < upperId,
    );

    // Compute stable prefix digest from checkpoint + suffix
    const checkpointPart = checkpoint ? checkpoint.content : "";
    const suffixPart = suffixMessages.map(m => `${m.role}:${m.content}`).join("\n");
    const stablePrefix = `${checkpointPart}\n${suffixPart}`;
    const stablePrefixDigest = computeDigest(stablePrefix);

    const estimatedTokens = checkpoint
      ? checkpoint.content.length / CHARS_PER_TOKEN
      : 0;
    const suffixTokens = suffixMessages.reduce(
      (s, m) => s + Math.ceil(m.content.length / CHARS_PER_TOKEN),
      0,
    );

    return {
      checkpoint,
      messages: suffixMessages,
      estimatedTokens: Math.ceil(estimatedTokens + suffixTokens),
      stablePrefixDigest,
      rendererVersion: "checkpoint-v1",
    };
  }

  /** Reset/archive checkpoint lineage for a session. */
  resetCheckpoints(chatId: string): void {
    this.db.prepare(`DELETE FROM ${ACTIVE_POINTER_TABLE} WHERE chat_id = ?`).run(chatId);
  }

  // ── private ────────────────────────────────────────────────────────────────

  private rowToRecord(row: Record<string, unknown>): CheckpointRecord {
    return {
      id: row.id as number,
      chatId: row.chat_id as string,
      previousCheckpointId: row.previous_checkpoint_id as number | null,
      sourceMessageStart: row.source_message_start as number,
      sourceMessageEnd: row.source_message_end as number,
      firstKeptMessageId: row.first_kept_message_id as number,
      content: row.content as string,
      sourceTokenCount: row.source_token_count as number,
      checkpointTokenCount: row.checkpoint_token_count as number,
      sourceDigest: row.source_digest as string,
      checkpointDigest: row.checkpoint_digest as string,
      summarizerModel: row.summarizer_model as string | null,
      summarizerProvider: row.summarizer_provider as string | null,
      activeRequestModel: row.active_request_model as string,
      reason: row.reason as string,
      budgetJson: row.budget_json as string,
      classification: row.classification as number,
      promptVersion: row.prompt_version as string,
      schemaVersion: row.schema_version as number,
      serializerVersion: row.serializer_version as string,
      createdAt: row.created_at as number,
    };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

export function computeDigest(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
