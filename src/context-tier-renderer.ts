/**
 * context-tier-renderer.ts — Three-tier context assembly (#348).
 *
 * Assembles API context in three tiers:
 *   - tail:   last N turns, verbatim prose
 *   - middle: next M turns, ABM-L rendering via stored hints (pure function)
 *   - head:   older than tail+middle, represented via #319 summaries
 *
 * Phase 1: pure-function heuristic. No LLM, no cache, no batching.
 * Phase 2 (behind COMPACTION_LLM_ENABLED=true): optional LLM refinement
 * layer that takes heuristic output and refines it. Caches result.
 * Heuristic is always the fallback — LLM never replaces, only enhances.
 *
 * ABM-L is render-only. Stored messages stay as raw prose + structured
 * metadata columns. Compression happens at assembly time only.
 */

import type Database from "better-sqlite3";
import { getAbmindEnv } from "./env-schema.js";
import { ContextEngine } from "./context-engine.js";
import type { ContextMessage, ContextSummary } from "./context-engine.js";
import {
  determineTier,
  renderMiddleTurn,
  CHARS_PER_TOKEN,
  type MessageWithHints,
  type Tier,
} from "./context-render-primitives.js";
// Re-exported for existing importers (tests, tier-llm-refinement); the
// canonical definitions live in context-render-primitives.ts (#1883).
export { determineTier, renderMiddleTurn, CHARS_PER_TOKEN, type MessageWithHints, type Tier };
import { logDebug } from "./mem-logger.js";
import { LlmRefinementCache } from "./tier-llm-refinement.js";

const TAG = "context-tier-renderer";

export interface TierBreakdown {
  tailCount: number;
  middleCount: number;
  headCount: number;  // number of summaries injected
}

export interface TieredContextResult {
  messages: Array<{ role: string; content: string }>;
  tierBreakdown: TierBreakdown;
  estimatedTokens: number;
}

const SUMMARY_FRAMING = "[Context summary — earlier in this conversation (internal reference — never echo this format in replies)]";

/** Module-level LRU cache for Phase 2 LLM refinement. */
const llmCache = new LlmRefinementCache(10_000);

/** Exposed for tests / debugging. */
export function _getLlmCache(): LlmRefinementCache {
  return llmCache;
}

/**
 * Main assembly entry point. Builds the three-tier context from DB state.
 *
 * Order of operations:
 *   1. Load raw context via ContextEngine.buildContext() (#319 summaries + messages)
 *   2. Apply tier boundaries (pure function of position)
 *   3. Render: tail verbatim, middle via ABM-L, head as injected summaries
 *   4. Return TieredContextResult with breakdown + token estimate
 *
 * If CONTEXT_TIER_ENABLED=false, falls back to the legacy binary assembly
 * (raw messages + summary head, no middle tier).
 *
 * @param options.beforeMessageId — #1329 exclusive upper bound for raw messages.
 *   Threads through to ContextEngine.buildContext(). Hint loading uses the
 *   bounded snapshot IDs (loadMessagesWithHints is id-IN-filtered) and will
 *   not independently reload excluded rows.
 * @param options.fromMessageId — #1406 inclusive lower bound override for the
 *   append-only suffix below the active checkpoint. Threads through to
 *   ContextEngine.buildContext().
 * @param options.skipSummaries — #1406: when the session has an active
 *   checkpoint lineage, archived legacy summaries must not be injected as an
 *   independent head tier (they would represent the compacted prefix twice).
 */
export function renderForContext(
  db: Database.Database,
  engine: ContextEngine,
  chatId: string,
  options?: { beforeMessageId?: number; fromMessageId?: number; skipSummaries?: boolean },
): TieredContextResult {
  const env = getAbmindEnv();
  const snapshot = engine.buildContext(chatId, options);
  if (options?.skipSummaries) snapshot.summaries = [];

  if (!env.contextTierEnabled) {
    // Fallback: legacy #319 binary behavior — summaries + all raw messages
    return renderLegacyBinary(snapshot);
  }

  // Load full message rows with hints (buildContext returns minimal ContextMessage)
  const hintRows = loadMessagesWithHints(db, chatId, snapshot.messages.map(m => m.id));

  // Tier determination (pure function of position)
  const totalMessages = hintRows.length;
  const tailSize = env.contextTierTail;
  const middleSize = env.contextTierMiddle;

  const tierOfIndex = (idx: number): Tier => {
    const posFromEnd = totalMessages - 1 - idx;
    return determineTier(posFromEnd, tailSize, middleSize);
  };

  // Build final messages array: head summaries first, then middle, then tail
  const contextMessages: Array<{ role: string; content: string }> = [];

  // Head tier — inject summaries as user messages with framing
  for (const summary of snapshot.summaries) {
    contextMessages.push({ role: "user", content: `${SUMMARY_FRAMING}\n\n${summary.content}` });
  }

  let middleCount = 0;
  let tailCount = 0;

  for (let i = 0; i < hintRows.length; i++) {
    const msg = hintRows[i];
    if (!msg) continue;
    const tier = tierOfIndex(i);

    if (tier === "tail") {
      // Verbatim
      contextMessages.push({ role: msg.role, content: msg.content });
      tailCount++;
    } else if (tier === "middle") {
      // Check LLM refinement cache (only when COMPACTION_LLM_ENABLED)
      let rendered: string;
      if (env.compactionLlmEnabled) {
        const cached = llmCache.get(chatId, msg.id);
        rendered = cached ?? renderMiddleTurn(msg);
      } else {
        rendered = renderMiddleTurn(msg);
      }
      contextMessages.push({ role: msg.role, content: rendered });
      middleCount++;
    }
    // Head messages are not included here — they should have been folded into summaries.
    // If they appear here it means #319 hasn't compacted yet. Skip; will appear in tail/middle
    // when position changes.
  }

  const estimatedTokens = contextMessages.reduce(
    (sum, m) => sum + Math.ceil(m.content.length / CHARS_PER_TOKEN),
    0,
  );

  logDebug(TAG, `tier assembly: head=${snapshot.summaries.length} middle=${middleCount} tail=${tailCount} est=${estimatedTokens}tok`);

  return {
    messages: contextMessages,
    tierBreakdown: {
      tailCount,
      middleCount,
      headCount: snapshot.summaries.length,
    },
    estimatedTokens,
  };
}

function renderLegacyBinary(snapshot: {
  summaries: ContextSummary[];
  messages: ContextMessage[];
}): TieredContextResult {
  const contextMessages: Array<{ role: string; content: string }> = [];
  for (const summary of snapshot.summaries) {
    contextMessages.push({ role: "user", content: `${SUMMARY_FRAMING}\n\n${summary.content}` });
  }
  for (const msg of snapshot.messages) {
    contextMessages.push({ role: msg.role, content: msg.content });
  }
  const estimatedTokens = contextMessages.reduce(
    (sum, m) => sum + Math.ceil(m.content.length / CHARS_PER_TOKEN),
    0,
  );
  return {
    messages: contextMessages,
    tierBreakdown: {
      tailCount: snapshot.messages.length,
      middleCount: 0,
      headCount: snapshot.summaries.length,
    },
    estimatedTokens,
  };
}

function loadMessagesWithHints(
  db: Database.Database,
  chatId: string,
  ids: number[],
): MessageWithHints[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, role, content, timestamp, type_hint, topic_hint, emotion_hint
     FROM messages
     WHERE session_id = ? AND id IN (${placeholders})
     ORDER BY timestamp ASC, id ASC`,
  ).all(chatId, ...ids) as Array<{
    id: number;
    role: string;
    content: string;
    timestamp: number;
    type_hint: string | null;
    topic_hint: string | null;
    emotion_hint: string | null;
  }>;
  return rows.map(r => ({
    id: r.id,
    role: r.role,
    content: r.content,
    timestamp: r.timestamp,
    type_hint: r.type_hint,
    topic_hint: r.topic_hint,
    emotion_hint: r.emotion_hint,
  }));
}
