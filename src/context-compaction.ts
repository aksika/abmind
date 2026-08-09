/**
 * context-compaction.ts — owner-scoped durable conversation compaction (#1406).
 *
 * This module is the single durable compaction authority in the daemon:
 *   - complete-turn selection over append-only durable rows;
 *   - canonical source serialization and digest (role/content/ID, not display
 *     rendering);
 *   - generation-guarded prepare/commit (CAS);
 *   - transactional migration of legacy context_summaries/context_watermarks
 *     state into the cumulative checkpoint lineage.
 *
 * Only the daemon that owns SQLite calls these functions. No provider SDK or
 * summarizer is ever imported here — abtars executes provider work and returns
 * a bounded summary for server-side revalidation.
 */

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { CheckpointStore, computeDigest } from "./context-checkpoint-store.js";
import { logError } from "./mem-logger.js";

export const COMPACTION_PROTOCOL_VERSION = 1 as const;
/** Upper bound for the serialized source carried in a prepare response. */
export const COMPACTION_PAYLOAD_MAX_BYTES = 240_000;
/** Upper bound for a checkpoint summary body. */
export const COMPACTION_SUMMARY_MAX_CHARS = 120_000;
/** Lower bound on a summary output budget. */
export const COMPACTION_BUDGET_MIN_TOKENS = 2_000;
/** Upper bound on a summary output budget. */
export const COMPACTION_BUDGET_MAX_TOKENS = 12_000;
/** Fraction of source tokens used as the summary budget. */
export const COMPACTION_BUDGET_FRACTION = 0.2;
/** Time a prepared candidate stays in-flight (busy) without a commit. */
export const COMPACTION_PREPARE_TTL_MS = 120_000;

export interface CompactionMessageRow {
  id: number;
  role: string;
  content: string;
}

export interface CompactionSelectionInput {
  userId: string;
  sessionId: string;
  beforeMessageId?: number;
  maxHistoryTokens: number;
  minRecentTokens: number;
  reason: "manual" | "automatic";
}

export interface CompactionCandidateV1 {
  version: 1;
  expectedGeneration: number;
  previousCheckpointId: number | null;
  sourceMessageStart: number;
  sourceMessageEnd: number;
  firstKeptMessageId: number;
  sourceDigest: string;
  sourceTokenCount: number;
  serializedTurns: string;
  priorCheckpoint: string;
  summaryTokenBudget: number;
}

/** Commit input carries the proof fields only — the server reloads the rows. */
export type CompactionCandidateProofV1 = Omit<
  CompactionCandidateV1,
  "serializedTurns" | "priorCheckpoint" | "summaryTokenBudget"
>;

export type PrepareCompactionResultV1 =
  | { status: "nothing_to_compact" }
  | { status: "busy" }
  | { status: "ready"; candidate: CompactionCandidateV1 };

export type CommitCompactionResultV1 =
  | { status: "committed"; checkpointId: number; generation: number }
  | { status: "stale" }
  | { status: "rejected" };

// ── Turn units (#1335 grouping rules, moved to the durable owner) ───────────

interface TurnUnit {
  /** start index into the source message array (inclusive). */
  startIdx: number;
  /** end index into the source message array (inclusive). */
  endIdx: number;
  /** durable ID of the first message in the unit. */
  startId: number;
  /** durable ID of the last message in the unit. */
  endId: number;
  /** true when the unit ends with a final assistant message (answerable turn). */
  complete: boolean;
  /** estimated token weight of the whole unit. */
  tokens: number;
}

/** Group a flat message array into whole turn units. A unit starts at a user
 *  message (or the array head) and extends through the following
 *  assistant/tool messages up to the next user. It is complete iff its last
 *  message is an assistant message. */
export function groupTurnUnits(messages: CompactionMessageRow[]): TurnUnit[] {
  const units: TurnUnit[] = [];
  let startIdx = 0;
  for (let i = 0; i < messages.length; i++) {
    const startsNewTurn = messages[i]!.role === "user" && i > startIdx;
    if (!startsNewTurn) continue;
    units.push(makeUnit(messages, startIdx, i - 1));
    startIdx = i;
  }
  if (startIdx < messages.length) {
    units.push(makeUnit(messages, startIdx, messages.length - 1));
  }
  return units;
}

function makeUnit(messages: CompactionMessageRow[], startIdx: number, endIdx: number): TurnUnit {
  let chars = 0;
  for (let i = startIdx; i <= endIdx; i++) {
    chars += messages[i]!.content.length;
  }
  return {
    startIdx,
    endIdx,
    startId: messages[startIdx]!.id,
    endId: messages[endIdx]!.id,
    complete: messages[endIdx]!.role === "assistant",
    tokens: Math.ceil(chars / 4),
  };
}

/** Canonical source serialization: one message per line, role/content/ID. */
export function canonicalSerializeMessages(rows: CompactionMessageRow[]): string {
  return rows.map(m => `${m.id}\t${m.role}\t${m.content}`).join("\n");
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

// ── Row loading (owner/session scoped, append-only) ─────────────────────────

function loadRows(
  db: Database.Database,
  userId: string,
  sessionId: string,
  lowerId: number,
  upperId?: number,
): CompactionMessageRow[] {
  const upper = typeof upperId === "number" ? "AND id < ?" : "";
  const params: Array<string | number> = [userId, sessionId, lowerId];
  if (typeof upperId === "number") params.push(upperId);
  const rows = db.prepare(
    `SELECT id, role, content FROM messages
     WHERE user_id = ? AND session_id = ? AND id >= ? ${upper}
     ORDER BY id`,
  ).all(...params) as Array<{ id: number; role: string; content: string }>;
  return rows.map(r => ({ id: r.id, role: r.role, content: r.content }));
}

/**
 * Read-only selection of a compaction candidate. Never mutates state.
 * Returns nothing_to_compact when no complete prefix remains or when the
 * session is unknown/foreign (bounded, no owner leak).
 */
export function selectCompactionCandidate(
  db: Database.Database,
  input: CompactionSelectionInput,
): { status: "nothing_to_compact" } | { status: "ready"; candidate: CompactionCandidateV1 } {
  // Owner/session existence probe (bounded; foreign sessions look empty).
  const ownerRow = db.prepare(
    "SELECT 1 FROM messages WHERE user_id = ? AND session_id = ? LIMIT 1",
  ).get(input.userId, input.sessionId);
  if (!ownerRow) return { status: "nothing_to_compact" };
  const foreign = db.prepare(
    "SELECT 1 FROM messages WHERE session_id = ? AND user_id != ? LIMIT 1",
  ).get(input.sessionId, input.userId);
  if (foreign) return { status: "nothing_to_compact" };

  const store = new CheckpointStore(db);
  const ptr = store.getActivePointer(input.sessionId);
  const prior = ptr ? store.getCheckpoint(ptr.checkpointId) : null;
  const lowerId = prior?.firstKeptMessageId ?? 0;

  const rows = loadRows(db, input.userId, input.sessionId, lowerId, input.beforeMessageId);
  if (rows.length < 2) return { status: "nothing_to_compact" };

  const units = groupTurnUnits(rows);
  if (units.length < 2) return { status: "nothing_to_compact" };

  const totalTokens = units.reduce((s, u) => s + u.tokens, 0);
  // History-budget gate: if the real stable context already fits there is
  // nothing to compact, unless the user explicitly requested compaction.
  if (input.reason !== "manual" && input.maxHistoryTokens > 0 && totalTokens <= input.maxHistoryTokens) {
    return { status: "nothing_to_compact" };
  }

  // Minimum recent complete suffix: walk backward from the newest unit,
  // retaining whole turns until the recent-token floor is met. The trailing
  // (possibly in-flight) incomplete unit is always retained.
  let suffixTokens = 0;
  let suffixUnitStart = units.length - 1;
  for (let u = units.length - 1; u >= 0; u--) {
    suffixTokens += units[u]!.tokens;
    suffixUnitStart = u;
    if (suffixTokens >= input.minRecentTokens) break;
  }
  // If the entire conversation is the suffix, nothing is left to compact.
  if (suffixUnitStart <= 0) return { status: "nothing_to_compact" };

  // Compact only the contiguous complete prefix preceding the suffix.
  let compactEndUnit = suffixUnitStart - 1;
  while (compactEndUnit >= 0 && !units[compactEndUnit]!.complete) compactEndUnit--;
  if (compactEndUnit < 0) return { status: "nothing_to_compact" };

  // #1406 review: an incomplete mid-history unit (abandoned user→tool
  // exchange) may not be checkpointed and must stay visible, so nothing after
  // it may be compacted either — it becomes the suffix start.
  const firstIncompleteIdx = units.findIndex(u => !u.complete);
  if (firstIncompleteIdx >= 0 && firstIncompleteIdx <= compactEndUnit) {
    compactEndUnit = firstIncompleteIdx - 1;
    if (compactEndUnit < 0) return { status: "nothing_to_compact" };
  }

  let compacted = units.slice(0, compactEndUnit + 1);
  if (compacted.length === 0) return { status: "nothing_to_compact" };

  // Payload bound: shrink at complete-turn boundaries (never inside a turn).
  while (
    compacted.length > 1
    && Buffer.byteLength(canonicalSerializeMessages(rows.slice(compacted[0]!.startIdx, compacted[compacted.length - 1]!.endIdx + 1)), "utf-8") > COMPACTION_PAYLOAD_MAX_BYTES
  ) {
    compacted = compacted.slice(0, -1);
  }

  const firstUnit = compacted[0]!;
  const lastUnit = compacted[compacted.length - 1]!;
  const sourceRows = rows.slice(firstUnit.startIdx, lastUnit.endIdx + 1);
  if (sourceRows.length < 2) return { status: "nothing_to_compact" };

  const serializedTurns = canonicalSerializeMessages(sourceRows);
  if (Buffer.byteLength(serializedTurns, "utf-8") > COMPACTION_PAYLOAD_MAX_BYTES) {
    return { status: "nothing_to_compact" };
  }

  const sourceTokenCount = estimateTokens(serializedTurns.length);
  const sourceDigest = computeDigest(serializedTurns);

  // firstKeptMessageId is the real first suffix row — never sourceEnd + 1.
  const keptUnit = units[compacted.length];
  if (!keptUnit) return { status: "nothing_to_compact" };

  return {
    status: "ready",
    candidate: {
      version: 1,
      expectedGeneration: ptr?.generation ?? 0,
      previousCheckpointId: ptr?.checkpointId ?? null,
      sourceMessageStart: firstUnit.startId,
      sourceMessageEnd: lastUnit.endId,
      firstKeptMessageId: keptUnit.startId,
      sourceDigest,
      sourceTokenCount,
      serializedTurns,
      priorCheckpoint: prior?.content ?? "",
      summaryTokenBudget: Math.max(
        COMPACTION_BUDGET_MIN_TOKENS,
        Math.min(Math.floor(sourceTokenCount * COMPACTION_BUDGET_FRACTION), COMPACTION_BUDGET_MAX_TOKENS),
      ),
    },
  };
}

// ── Commit (transactional, generation CAS) ──────────────────────────────────

export interface CommitCompactionInput {
  userId: string;
  sessionId: string;
  candidate: CompactionCandidateProofV1;
  summary: string;
  summaryTokenCount: number;
  summarizer: { provider: string | null; model: string | null };
  activeRequestModel: string | null;
  reason: "manual" | "automatic";
  customInstructionsDigest?: string;
}

/**
 * Revalidate and atomically commit a checkpoint. Performs no partial write on
 * any failed invariant. Returns committed/stale/rejected; nothing is ever
 * reported committed unless both the checkpoint insert and the generation
 * CAS pointer advance succeeded.
 */
export function commitConversationCheckpoint(
  db: Database.Database,
  input: CommitCompactionInput,
): CommitCompactionResultV1 {
  const { candidate } = input;
  if (
    !Number.isSafeInteger(candidate.sourceMessageStart)
    || !Number.isSafeInteger(candidate.sourceMessageEnd)
    || candidate.sourceMessageEnd < candidate.sourceMessageStart
  ) {
    return { status: "rejected" };
  }

  // 1. Reload the exact inclusive source range; every row must belong to the
  //    owner and session.
  const store = new CheckpointStore(db);
  const rows = db.prepare(
    `SELECT id, role, content FROM messages
     WHERE user_id = ? AND session_id = ? AND id >= ? AND id <= ?
     ORDER BY id`,
  ).all(input.userId, input.sessionId, candidate.sourceMessageStart, candidate.sourceMessageEnd) as Array<{
    id: number; role: string; content: string;
  }>;

  if (rows.length < 2) return { status: "rejected" };
  if (rows[0]!.id !== candidate.sourceMessageStart || rows[rows.length - 1]!.id !== candidate.sourceMessageEnd) {
    return { status: "rejected" };
  }

  // 2. Same canonical serialization → same digest and token count.
  const serializedTurns = canonicalSerializeMessages(rows);
  if (computeDigest(serializedTurns) !== candidate.sourceDigest) return { status: "rejected" };
  if (estimateTokens(serializedTurns.length) !== candidate.sourceTokenCount) return { status: "rejected" };

  // 3. Regroup complete turns: every compacted unit must be a complete
  //    (final-assistant) turn — an incomplete unit is never checkpointed.
  const units = groupTurnUnits(rows);
  if (units.length === 0 || !units.every(u => u.complete)) return { status: "rejected" };

  // 4. Lineage identity: the candidate must chain from the active pointer's
  //    checkpoint (or from an absent pointer). The generation CAS below
  //    remains the final arbiter if the pointer moves concurrently.
  const pointer = store.getActivePointer(input.sessionId);
  if ((pointer?.checkpointId ?? null) !== candidate.previousCheckpointId) {
    return { status: "stale" };
  }

  // 5. firstKeptMessageId must be the first actual suffix row (id > sourceEnd).
  const keptRow = db.prepare(
    "SELECT id FROM messages WHERE user_id = ? AND session_id = ? AND id > ? ORDER BY id LIMIT 1",
  ).get(input.userId, input.sessionId, candidate.sourceMessageEnd) as { id: number } | undefined;
  if (!keptRow || keptRow.id !== candidate.firstKeptMessageId) return { status: "rejected" };

  // 6. Summary sanity: non-empty, bounded, and a real reduction of the source.
  const summary = input.summary.trim();
  if (summary.length === 0) return { status: "rejected" };
  if (summary.length > COMPACTION_SUMMARY_MAX_CHARS) return { status: "rejected" };
  const checkpointTokenCount = estimateTokens(summary.length);
  if (checkpointTokenCount >= candidate.sourceTokenCount) return { status: "rejected" };

  // 7. Atomic insert + generation-guarded CAS pointer advance.
  const checkpointId = store.commitCheckpoint(input.sessionId, {
    previousCheckpointId: candidate.previousCheckpointId,
    sourceMessageStart: candidate.sourceMessageStart,
    sourceMessageEnd: candidate.sourceMessageEnd,
    firstKeptMessageId: candidate.firstKeptMessageId,
    content: summary,
    sourceTokenCount: candidate.sourceTokenCount,
    checkpointTokenCount,
    sourceDigest: candidate.sourceDigest,
    checkpointDigest: computeDigest(summary),
    summarizerModel: input.summarizer.model,
    summarizerProvider: input.summarizer.provider,
    activeRequestModel: input.activeRequestModel ?? "",
    reason: input.reason,
    budgetJson: JSON.stringify({ reason: input.reason, authority: "checkpoint-v1" }),
    classification: 1,
    promptVersion: "compact-v1",
    schemaVersion: 1,
    serializerVersion: "durable-rows-v1",
  }, candidate.expectedGeneration);

  if (checkpointId < 0) return { status: "stale" };
  return {
    status: "committed",
    checkpointId,
    generation: candidate.expectedGeneration + 1,
  };
}

// ── In-flight (busy) tracking ───────────────────────────────────────────────

/**
 * Per-service compaction coordination. Holds one in-flight slot per session
 * from prepare until commit (or a bounded TTL) so a concurrent automatic and
 * manual compaction cannot interleave; the server-side generation CAS remains
 * the final arbiter.
 */
export class ContextCompactionService {
  private readonly db: Database.Database;
  private readonly inflight = new Map<string, { timer: ReturnType<typeof setTimeout>; since: number }>();

  constructor(db: Database.Database) {
    this.db = db;
  }

  prepare(input: CompactionSelectionInput): PrepareCompactionResultV1 {
    // Selection runs first: a foreign/unknown session yields
    // nothing_to_compact without ever observing the in-flight set, so the
    // busy status cannot leak another owner's activity.
    const result = selectCompactionCandidate(this.db, input);
    if (result.status !== "ready") return result;
    const existing = this.inflight.get(input.sessionId);
    if (existing && Date.now() - existing.since < COMPACTION_PREPARE_TTL_MS) {
      return { status: "busy" };
    }
    // A stale slot (e.g. the commit never reached this service because the
    // request failed at validation/transport level) self-heals after the TTL.
    if (existing) {
      clearTimeout(existing.timer);
      this.inflight.delete(input.sessionId);
    }
    const timer = setTimeout(() => this.inflight.delete(input.sessionId), COMPACTION_PREPARE_TTL_MS);
    if (typeof timer.unref === "function") timer.unref();
    this.inflight.set(input.sessionId, { timer, since: Date.now() });
    return result;
  }

  commit(input: CommitCompactionInput): CommitCompactionResultV1 {
    const outcome = commitConversationCheckpoint(this.db, input);
    const existing = this.inflight.get(input.sessionId);
    if (existing) {
      clearTimeout(existing.timer);
      this.inflight.delete(input.sessionId);
    }
    return outcome;
  }
}

// ── Legacy migration ────────────────────────────────────────────────────────

const LEGACY_FRAMING_PREFIX = "[context summary";

/**
 * Idempotent transactional migration of valid active legacy
 * context_summaries/context_watermarks state into one cumulative checkpoint
 * for sessions without an active checkpoint. Returns the number of migrated
 * sessions.
 *
 * Each session is quarantined independently: a session with inconsistent
 * legacy state is left untouched, its failure is logged visibly (bounded,
 * content-free, session-fingerprinted), and migration continues with the
 * remaining sessions. A quarantined session is retried on every boot, so the
 * daemon never wedges on legacy data and the data can be repaired without
 * manual DB surgery. The projection never reads quarantined legacy state as
 * an independent authority (see ContextProjector.skipSummaries).
 */
export function migrateLegacySummaries(db: Database.Database): number {
  // The legacy tables may be absent on pre-existing databases that predate
  // the context tables entirely; there is nothing to migrate then.
  const table = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_summaries'",
  ).get();
  if (!table) return 0;

  const sessions = db.prepare(
    "SELECT DISTINCT chat_id FROM context_summaries WHERE archived = 0",
  ).all() as Array<{ chat_id: string }>;

  let migrated = 0;
  for (const { chat_id: chatId } of sessions) {
    try {
      if (migrateOneSession(db, chatId)) migrated++;
    } catch (err) {
      // Quarantine: leave the session's legacy rows untouched, report the
      // failure visibly, and retry on the next boot.
      const fingerprint = createHash("sha256").update(chatId, "utf-8").digest("hex").slice(0, 8);
      logError("context-compaction", `Legacy compaction migration quarantined session ${fingerprint}..: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return migrated;
}

function migrateOneSession(db: Database.Database, chatId: string): boolean {
  const hasCheckpoint = db.prepare(
    "SELECT 1 FROM active_context_checkpoint WHERE chat_id = ?",
  ).get(chatId);
  if (hasCheckpoint) return false;

  const summaries = db.prepare(
    `SELECT id, content, token_estimate, source_message_start, source_message_end, classification
     FROM context_summaries
     WHERE chat_id = ? AND archived = 0
     ORDER BY source_message_start ASC, id ASC`,
  ).all(chatId) as Array<{
    id: number; content: string; token_estimate: number;
    source_message_start: number; source_message_end: number; classification: number;
  }>;
  if (summaries.length === 0) return false;

  // Validate: ordered, non-overlapping source ranges.
  for (let i = 1; i < summaries.length; i++) {
    const prev = summaries[i - 1]!;
    const next = summaries[i]!;
    if (next.source_message_start <= prev.source_message_end) {
      throw new Error("overlapping summary ranges");
    }
  }

  const first = summaries[0]!;
  const last = summaries[summaries.length - 1]!;

  // Watermark must be consistent with the final range.
  const wm = db.prepare(
    "SELECT watermark_message_id FROM context_watermarks WHERE chat_id = ?",
  ).get(chatId) as { watermark_message_id: number } | undefined;
  if (!wm) {
    throw new Error("missing watermark");
  }
  if (wm.watermark_message_id !== last.source_message_end + 1) {
    throw new Error("watermark inconsistent with final range");
  }

  // The watermark is the first-kept bound by definition (the legacy
  // summarizer advanced it past the last summarized row).
  const firstKeptMessageId = wm.watermark_message_id;

  const framed = summaries.map((s, i) =>
    `${LEGACY_FRAMING_PREFIX} ${i + 1} of ${summaries.length}]\n${s.content}`,
  ).join("\n\n");
  const content = framed;
  const sourceTokenCount = summaries.reduce((s, x) => s + x.token_estimate, 0);
  const classification = summaries.reduce((m, x) => Math.max(m, x.classification), 1);

  const migrateOne = db.transaction(() => {
    const store = new CheckpointStore(db);
    const checkpointId = store.commitCheckpoint(chatId, {
      previousCheckpointId: null,
      sourceMessageStart: first.source_message_start,
      sourceMessageEnd: last.source_message_end,
      firstKeptMessageId,
      content,
      sourceTokenCount,
      checkpointTokenCount: estimateTokens(content.length),
      sourceDigest: computeDigest(content),
      checkpointDigest: computeDigest(content),
      summarizerModel: null,
      summarizerProvider: null,
      activeRequestModel: "legacy-migration",
      reason: "migration",
      budgetJson: JSON.stringify({ source: "legacy-summaries", sessions: summaries.length }),
      classification,
      promptVersion: "legacy-migration-v1",
      schemaVersion: 1,
      serializerVersion: "legacy-summaries-v1",
    }, 0);
    if (checkpointId < 0) {
      throw new Error("concurrent checkpoint appeared");
    }
    db.prepare("UPDATE context_summaries SET archived = 1 WHERE chat_id = ? AND archived = 0").run(chatId);
  });
  migrateOne();
  return true;
}
