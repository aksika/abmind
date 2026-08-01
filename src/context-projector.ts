/**
 * context-projector.ts — daemon-owned read-only conversation projection (#1527).
 *
 * The hot durable read boundary for Pi sessions. Validates user/session/cursor
 * ownership against the daemon-owned database, then renders history through the
 * shared three-tier renderer with tool pruning and token estimation.
 *
 * Owns no summarizer, no compaction trigger, no mutable anti-thrash state, and
 * no provider callback — reads only. Compaction maintenance stays in
 * ContextOrchestrator (#1406).
 */

import type Database from "better-sqlite3";
import { ContextEngine, CHARS_PER_TOKEN, TAIL_MIN_MESSAGES } from "./context-engine.js";
import { renderForContext, type TierBreakdown } from "./context-tier-renderer.js";
import { pruneToolResults } from "./tool-result-pruner.js";

const TAG = "context-projector";
const PRUNING_THRESHOLD_PCT = 0.35;
const GAP_AGGRESSIVE_MS = 60 * 60 * 1000; // 1 hour

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
  | "mixed_owner";

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

/**
 * Shared internal projection pipeline used by ContextOrchestrator.getContext()
 * and ContextProjector. Pure read: render + prune + token estimate.
 */
export interface ProjectedRowsV1 extends ProjectedConversationContextV1 {
  tierBreakdown: TierBreakdown;
}

export function projectContextRows(
  db: Database.Database,
  engine: ContextEngine,
  chatId: string,
  tokenBudget: number,
  options: { beforeMessageId?: number; gapMs?: number },
): ProjectedRowsV1 {
  const tiered = renderForContext(db, engine, chatId, options?.beforeMessageId !== undefined ? { beforeMessageId: options.beforeMessageId } : undefined);

  const contextMessages = tiered.messages.slice();

  const gap = options.gapMs ?? 0;
  const aggressive = gap > GAP_AGGRESSIVE_MS;
  const estimatedTokens = tiered.estimatedTokens;
  let pruned = 0;

  const totalMessageCount = tiered.tierBreakdown.tailCount + tiered.tierBreakdown.middleCount;
  if (aggressive || estimatedTokens > tokenBudget * PRUNING_THRESHOLD_PCT) {
    const tailCount = Math.max(TAIL_MIN_MESSAGES, Math.min(totalMessageCount, Math.ceil(totalMessageCount * 0.3)));
    const pruneResult = pruneToolResults(contextMessages as Parameters<typeof pruneToolResults>[0], tailCount, aggressive);
    pruned = pruneResult.prunedCount;
    if (pruned > 0) {
      contextMessages.splice(0, contextMessages.length, ...pruneResult.messages as Array<{ role: string; content: string }>);
    }
  }

  const finalTokens = contextMessages.reduce((s, m) => s + Math.ceil(m.content.length / CHARS_PER_TOKEN), 0);
  return {
    version: 1,
    messages: contextMessages.map(m => ({ role: mapRole(m.role), content: m.content })),
    estimatedTokens: finalTokens,
    prunedToolResults: pruned,
    sourceMessageCount: totalMessageCount,
    tierBreakdown: tiered.tierBreakdown,
  };
}

/**
 * Owner-scoped read-only projector over a daemon-owned database. Constructed
 * with the daemon's SQLite handle via package-internal access; never exported
 * from the public package surface.
 */
export class ContextProjector {
  private readonly db: Database.Database;
  private readonly engine: ContextEngine;

  constructor(db: Database.Database) {
    this.db = db;
    this.engine = new ContextEngine(db);
  }

  /**
   * Project durable history strictly before `beforeMessageId` for one owner's
   * session. Fails closed on any ownership or cursor violation.
   */
  project(input: ProjectConversationContextInputV1): ProjectedConversationContextV1 {
    // 1. Cursor binding: the cursor row must exist and belong to the caller.
    const cursor = this.db.prepare(
      "SELECT user_id, session_id FROM messages WHERE id = ?",
    ).get(input.beforeMessageId) as { user_id: string; session_id: string } | undefined;
    if (!cursor) throw new ContextProjectionError("cursor_not_found");
    if (cursor.user_id !== input.userId || cursor.session_id !== input.sessionId) {
      throw new ContextProjectionError("cursor_owner_mismatch");
    }

    // 2. Mixed-owner invariant: no eligible row for this session may belong to
    //    another user. Deny before rendering rather than leaking a partial
    //    projection from a malformed or reused session ID.
    const foreign = this.db.prepare(
      "SELECT 1 FROM messages WHERE session_id = ? AND user_id != ? LIMIT 1",
    ).get(input.sessionId, input.userId);
    if (foreign) throw new ContextProjectionError("mixed_owner");

    // 3. Render (session-scoped; ownership proven above) with pruning.
    const rows = projectContextRows(this.db, this.engine, input.sessionId, input.maxContext, {
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

// Re-export for diagnostics without importing the renderer directly.
export { TAG as CONTEXT_PROJECTOR_TAG };
