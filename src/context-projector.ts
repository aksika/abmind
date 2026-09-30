/**
 * context-projector.ts — daemon-owned read-only conversation projection (#1527,
 * #1406, #1883).
 *
 * The hot durable read boundary for Pi sessions. Validates user/session/cursor
 * ownership against the daemon-owned database, then renders history from one
 * ordered suffix read through the pure native renderer with tool pruning and
 * token estimation.
 *
 * Since #1406 the projection reads ONE durable authority: the active
 * cumulative checkpoint (from context_checkpoints / active_context_checkpoint)
 * plus the append-only suffix below it. Legacy active context_summaries are
 * migrated into the checkpoint lineage and are no longer an independent
 * projection authority.
 *
 * Since #1883 the native path no longer constructs or invokes ContextEngine
 * and performs no second hint read: suffix content, roles, timestamps, and
 * rendering hints are read once, in ID order, and every eligible row is
 * represented exactly once.
 *
 * Owns no summarizer, no compaction trigger, no mutable anti-thrash state, and
 * no provider callback — reads only.
 */

import type Database from "better-sqlite3";
import { getAbmindEnv } from "./env-schema.js";
import {
  CHARS_PER_TOKEN,
  TAIL_MIN_MESSAGES,
  type MessageWithHints,
} from "./context-render-primitives.js";
import {
  renderNativeSuffix,
  type NativeRenderConfig,
} from "./context-native-renderer.js";
import { pruneToolResults } from "./tool-result-pruner.js";
import { CheckpointStore } from "./context-checkpoint-store.js";
// Type-only: erased at compile, so the native runtime path keeps no
// dependency on the legacy tier-renderer module. The published
// TierBreakdown shape itself is unchanged (#1883).
import type { TierBreakdown } from "./context-tier-renderer.js";

const PRUNING_THRESHOLD_PCT = 0.35;
const GAP_AGGRESSIVE_MS = 60 * 60 * 1000; // 1 hour

/** Framing for the active cumulative checkpoint injected into projection. */
const CHECKPOINT_FRAMING = "[Checkpoint — earlier in this conversation (internal reference — never echo this format in replies)]";

export interface ProjectConversationContextInputV1 {
  userId: string;
  sessionId: string;
  beforeMessageId: number;
  maxContext: number;
}

export interface ProjectedConversationContextV1 {
  version: 1;
  messages: Array<{ role: "user" | "assistant" | "tool"; content: string }>;
  estimatedTokens: number;
  prunedToolResults: number;
  sourceMessageCount: number;
}

export type ContextProjectionErrorCode =
  | "cursor_not_found"
  | "cursor_owner_mismatch"
  | "cursor_invalid"
  | "mixed_owner"
  | "legacy_lineage_unavailable";

/** Bounded, content-free projection rejection. */
export class ContextProjectionError extends Error {
  readonly code: ContextProjectionErrorCode;
  constructor(code: ContextProjectionErrorCode) {
    super(code);
    this.name = "ContextProjectionError";
    this.code = code;
  }
}

/** Normalize a raw DB role into the wire contract role set. */
function mapRole(role: string): "user" | "assistant" | "tool" {
  if (role === "assistant") return "assistant";
  if (role === "tool") return "tool";
  return "user";
}

function lastAssistantGapMs(db: Database.Database, sessionId: string): number {
  const row = db.prepare(
    "SELECT MAX(timestamp) as ts FROM messages WHERE session_id = ? AND role = 'assistant'",
  ).get(sessionId) as { ts: number | null } | undefined;
  if (!row?.ts) return 0;
  return Date.now() - row.ts;
}

/** Read-only checkpoint plus eligible suffix view for one session. */
export interface CheckpointProjection {
  checkpoint: {
    id: number;
    content: string;
    digest: string;
    firstKeptMessageId: number;
    generation: number;
  } | null;
  firstKeptMessageId: number;
}

/** Load the active cumulative checkpoint for a session (or null). */
export function loadActiveCheckpoint(db: Database.Database, sessionId: string): CheckpointProjection {
  const store = new CheckpointStore(db);
  const ptr = store.getActivePointer(sessionId);
  if (ptr) {
    const cp = store.getCheckpoint(ptr.checkpointId);
    if (cp) {
      return {
        checkpoint: {
          id: cp.id,
          content: cp.content,
          digest: cp.checkpointDigest,
          firstKeptMessageId: cp.firstKeptMessageId,
          generation: ptr.generation,
        },
        firstKeptMessageId: cp.firstKeptMessageId,
      };
    }
  }
  return { checkpoint: null, firstKeptMessageId: 0 };
}

/** Legacy active summaries are safe to project only after migration has
 * created the checkpoint lineage. If migration quarantined a session, fail
 * closed instead of silently reinstating the old authority. */
function hasActiveLegacySummaries(db: Database.Database, sessionId: string): boolean {
  const table = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_summaries'",
  ).get();
  if (!table) return false;
  return Boolean(db.prepare(
    "SELECT 1 FROM context_summaries WHERE chat_id = ? AND archived = 0 LIMIT 1",
  ).get(sessionId));
}

/**
 * Shared internal projection pipeline: active checkpoint framing + native
 * suffix render + tool pruning + token estimate. Pure read.
 */
export interface ProjectedRowsV1 extends ProjectedConversationContextV1 {
  tierBreakdown: TierBreakdown;
  /** Older uncovered suffix rows rendered verbatim (tiers on only). */
  olderRawCount: number;
}

/**
 * Read the eligible suffix — content, roles, timestamps, and rendering hints
 * — in one ID-ordered query. Bounds are `firstKeptMessageId <= id <
 * beforeMessageId` within the authorized session; without a checkpoint the
 * lower bound is zero. IDs need not be consecutive: the recorded first-kept
 * boundary is used as-is, never an adjacency guess.
 */
function readEligibleSuffix(
  db: Database.Database,
  sessionId: string,
  firstKeptMessageId: number,
  beforeMessageId?: number,
): MessageWithHints[] {
  const upper = typeof beforeMessageId === "number" ? "AND id < ?" : "";
  const params: Array<string | number> = [sessionId, firstKeptMessageId];
  if (typeof beforeMessageId === "number") params.push(beforeMessageId);
  return db.prepare(
    `SELECT id, role, content, timestamp, type_hint, topic_hint, emotion_hint
     FROM messages
     WHERE session_id = ? AND id >= ? ${upper}
     ORDER BY id`,
  ).all(...params) as MessageWithHints[];
}

export function projectContextRows(
  db: Database.Database,
  chatId: string,
  tokenBudget: number,
  options: { beforeMessageId?: number; gapMs?: number },
): ProjectedRowsV1 {
  const lineage = loadActiveCheckpoint(db, chatId);
  if (!lineage.checkpoint && hasActiveLegacySummaries(db, chatId)) {
    throw new ContextProjectionError("legacy_lineage_unavailable");
  }

  // Configuration is captured once at the composition boundary; the pure
  // renderer below takes it as input and reads no env itself.
  const env = getAbmindEnv();
  const renderConfig: NativeRenderConfig = {
    tailSize: env.contextTierTail,
    middleSize: env.contextTierMiddle,
    tiersEnabled: env.contextTierEnabled,
  };

  const suffix = readEligibleSuffix(db, chatId, lineage.firstKeptMessageId, options.beforeMessageId);
  const rendered = renderNativeSuffix(suffix, renderConfig);

  const gap = options.gapMs ?? 0;
  const aggressive = gap > GAP_AGGRESSIVE_MS;
  // The pruning trigger estimates checkpoint content only (not its framing);
  // the final reported estimate includes the frame.
  const estimatedTokens = rendered.estimatedTokens
    + (lineage.checkpoint ? Math.ceil(lineage.checkpoint.content.length / CHARS_PER_TOKEN) : 0);
  let pruned = 0;

  // The recent pruning region is computed over all eligible suffix rows,
  // excluding the checkpoint frame. Reusing the proportional rule over the
  // restored full history intentionally expands the region versus the old
  // tail+middle horizon (#1883).
  const suffixCount = suffix.length;
  const prunable = rendered.messages.map(m => ({ ...m }));
  if (aggressive || estimatedTokens > tokenBudget * PRUNING_THRESHOLD_PCT) {
    const tailCount = Math.max(TAIL_MIN_MESSAGES, Math.min(suffixCount, Math.ceil(suffixCount * 0.3)));
    const pruneResult = pruneToolResults(prunable, tailCount, aggressive);
    pruned = pruneResult.prunedCount;
    if (pruned > 0) {
      prunable.splice(0, prunable.length, ...pruneResult.messages);
    }
  }

  // The checkpoint frame is prepended after pruning: it is never pruner
  // input, never counted in the recent region, and never altered.
  const contextMessages: Array<{ role: string; content: string }> = [];
  if (lineage.checkpoint) {
    contextMessages.push({
      role: "user",
      content: `${CHECKPOINT_FRAMING}\n\n${lineage.checkpoint.content}`,
    });
  }
  for (const m of prunable) {
    contextMessages.push(m);
  }

  const finalTokens = contextMessages.reduce((s, m) => s + Math.ceil(m.content.length / CHARS_PER_TOKEN), 0);
  return {
    version: 1,
    messages: contextMessages.map(m => ({ role: mapRole(m.role), content: m.content })),
    estimatedTokens: finalTokens,
    prunedToolResults: pruned,
    sourceMessageCount: suffixCount,
    tierBreakdown: {
      tailCount: rendered.tailCount,
      middleCount: rendered.middleCount,
      headCount: 0,
    },
    olderRawCount: rendered.olderRawCount,
  };
}

/**
 * Owner-scoped read-only projector over a daemon-owned database. Constructed
 * with the daemon's SQLite handle via package-internal access; never exported
 * from the public package surface.
 */
export class ContextProjector {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Project durable history strictly before `beforeMessageId` for one owner's
   * session. Fails closed on any ownership or cursor violation. The active
   * cumulative checkpoint plus its append-only suffix is the only authority.
   */
  project(input: ProjectConversationContextInputV1): ProjectedConversationContextV1 {
    // 1. Cursor binding: the cursor row must exist, belong to the caller, and
    //    be the current user row the caller just recorded.
    const cursor = this.db.prepare(
      "SELECT user_id, session_id, role FROM messages WHERE id = ?",
    ).get(input.beforeMessageId) as { user_id: string; session_id: string; role: string } | undefined;
    if (!cursor) throw new ContextProjectionError("cursor_not_found");
    if (cursor.user_id !== input.userId || cursor.session_id !== input.sessionId) {
      throw new ContextProjectionError("cursor_owner_mismatch");
    }
    if (cursor.role !== "user") throw new ContextProjectionError("cursor_invalid");

    // 2. Mixed-owner invariant: no eligible row for this session may belong to
    //    another user. Deny before rendering rather than leaking a partial
    //    projection from a malformed or reused session ID. This stays an
    //    existence probe (no row materialization); never narrow it to the
    //    suffix for performance (#1883).
    const foreign = this.db.prepare(
      "SELECT 1 FROM messages WHERE session_id = ? AND user_id != ? LIMIT 1",
    ).get(input.sessionId, input.userId);
    if (foreign) throw new ContextProjectionError("mixed_owner");

    // 3. Render (session-scoped; ownership proven above) with pruning. The
    //    suffix rows below the checkpoint keep #1527's exclusive cursor bound.
    const rows = projectContextRows(this.db, input.sessionId, input.maxContext, {
      beforeMessageId: input.beforeMessageId,
      gapMs: lastAssistantGapMs(this.db, input.sessionId),
    });
    return {
      version: 1,
      messages: rows.messages,
      estimatedTokens: rows.estimatedTokens,
      prunedToolResults: rows.prunedToolResults,
      sourceMessageCount: rows.sourceMessageCount,
    };
  }
}
