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
import { renderMemory } from "./memory-renderer.js";
import { typeCodeToFull } from "./turn-classifier.js";
import { ContextEngine } from "./context-engine.js";
import type { ContextMessage, ContextSummary } from "./context-engine.js";
import { localMonth } from "./local-time.js";
import { logDebug } from "./mem-logger.js";
import { LlmRefinementCache, refineBatch, type RefineLlmFn } from "./tier-llm-refinement.js";

const TAG = "context-tier-renderer";

export type Tier = "tail" | "middle" | "head";

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

export interface MessageWithHints extends ContextMessage {
  type_hint?: string | null;
  topic_hint?: string | null;
  emotion_hint?: string | null;
}

const CHARS_PER_TOKEN = 4;
const SUMMARY_FRAMING = "[Context summary — earlier in this conversation (internal reference — never echo this format in replies)]";

/** Module-level LRU cache for Phase 2 LLM refinement. */
const llmCache = new LlmRefinementCache(10_000);

/** Exposed for tests / debugging. */
export function _getLlmCache(): LlmRefinementCache {
  return llmCache;
}

/**
 * Determine which tier a message belongs to based on its position from the end.
 * Pure function — deterministic given inputs.
 */
export function determineTier(
  positionFromEnd: number,
  tailSize: number,
  middleSize: number,
): Tier {
  if (positionFromEnd < tailSize) return "tail";
  if (positionFromEnd < tailSize + middleSize) return "middle";
  return "head";
}

/**
 * Render a single conversation turn as ABM-L using the configured codec.
 * Pure function of (message_with_hints, ABML_VERSION).
 *
 * Falls back to defaults when hints are null (historical messages from
 * before the classifier was added).
 */
export function renderMiddleTurn(msg: MessageWithHints): string {
  const typeCode = msg.type_hint ?? null;
  const memoryType = typeCodeToFull(typeCode);
  const topic = msg.topic_hint ?? "general";
  const emotion = msg.emotion_hint ?? "";
  const date = localMonth(new Date(msg.timestamp));

  return renderMemory({
    role: (msg.role === "assistant" || msg.role === "ASSISTANT" ? "assistant" : "user"),
    memory_type: memoryType,
    topic,
    emotion_tags: emotion,
    content_en: msg.content,
    confidence: 3,
    date,
  });
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
 */
export function renderForContext(
  db: Database.Database,
  engine: ContextEngine,
  chatId: string,
): TieredContextResult {
  const env = getAbmindEnv();
  const snapshot = engine.buildContext(chatId);

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

/**
 * Refine the middle tier via LLM batch call. Runs async, never blocks user.
 * Only acts when COMPACTION_LLM_ENABLED=true. Caches results per (chatId, messageId).
 *
 * Intended callers: afterTurn()/afterResponse() hooks in the transport layer.
 * Errors are swallowed (logged) — heuristic remains the fallback.
 */
export async function refineMiddleTierBatch(
  db: Database.Database,
  engine: ContextEngine,
  chatId: string,
  llmCall: RefineLlmFn,
  batchSize = 20,
): Promise<{ refined: number; skipped: number }> {
  const env = getAbmindEnv();
  if (!env.compactionLlmEnabled || !env.contextTierEnabled) {
    return { refined: 0, skipped: 0 };
  }

  const snapshot = engine.buildContext(chatId);
  const hintRows = loadMessagesWithHints(db, chatId, snapshot.messages.map(m => m.id));
  const totalMessages = hintRows.length;
  const tailSize = env.contextTierTail;
  const middleSize = env.contextTierMiddle;

  // Collect middle-tier messages that are not yet cached
  const uncached: MessageWithHints[] = [];
  for (let i = 0; i < hintRows.length; i++) {
    const msg = hintRows[i];
    if (!msg) continue;
    const posFromEnd = totalMessages - 1 - i;
    const tier = determineTier(posFromEnd, tailSize, middleSize);
    if (tier !== "middle") continue;
    if (llmCache.get(chatId, msg.id) !== null) continue;
    uncached.push(msg);
    if (uncached.length >= batchSize) break;
  }

  if (uncached.length === 0) return { refined: 0, skipped: 0 };

  const refined = await refineBatch(uncached, llmCall);
  // Populate cache — only entries the LLM successfully returned
  for (const [msgId, rendered] of refined.entries()) {
    llmCache.set(chatId, msgId, rendered);
  }

  const skipped = uncached.length - refined.size;
  logDebug(TAG, `LLM refinement: refined=${refined.size} skipped=${skipped} (fallback to heuristic for skipped)`);
  return { refined: refined.size, skipped };
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
