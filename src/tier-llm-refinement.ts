/**
 * tier-llm-refinement.ts — Optional LLM-based refinement for #348 Phase 2.
 *
 * Runs when COMPACTION_LLM_ENABLED=true. Takes heuristic-classified messages
 * and refines their ABM-L rendering via an LLM. Cached per (chatId, messageId).
 * Falls back to heuristic on any failure — never blocks, never replaces.
 *
 * Fires async in afterTurn() / afterResponse() — user never waits.
 */

import type { MessageWithHints } from "./context-tier-renderer.js";
import { logDebug, logWarn } from "./mem-logger.js";

const TAG = "tier-llm-refinement";

/**
 * LLM function signature for refinement.
 * Takes a system prompt + user prompt, returns refined output.
 */
export type RefineLlmFn = (systemPrompt: string, userPrompt: string, maxTokens?: number) => Promise<string>;

/** One cache entry: (chatId, messageId) → refined ABM-L string. */
interface CacheEntry {
  key: string;
  refined: string;
  renderedAt: number;
}

/**
 * Simple LRU cache. In-memory only. Lost on restart — acceptable because
 * next batch refills. Size cap prevents unbounded growth.
 */
export class LlmRefinementCache {
  private entries = new Map<string, CacheEntry>();
  private readonly maxSize: number;

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  get(chatId: string, messageId: number): string | null {
    const key = `${chatId}:${messageId}`;
    const entry = this.entries.get(key);
    if (!entry) return null;
    // Touch for LRU — delete + reinsert moves to end
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.refined;
  }

  set(chatId: string, messageId: number, refined: string): void {
    const key = `${chatId}:${messageId}`;
    if (this.entries.size >= this.maxSize && !this.entries.has(key)) {
      // Evict oldest (first in insertion order)
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey) this.entries.delete(oldestKey);
    }
    this.entries.set(key, { key, refined, renderedAt: Date.now() });
  }

  evictChatRange(chatId: string, startMessageId: number, endMessageId: number): number {
    let evicted = 0;
    for (const key of [...this.entries.keys()]) {
      if (!key.startsWith(`${chatId}:`)) continue;
      const msgIdStr = key.substring(chatId.length + 1);
      const msgId = Number(msgIdStr);
      if (msgId >= startMessageId && msgId <= endMessageId) {
        this.entries.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

const SYSTEM_PROMPT = `You are a context-compression assistant. Render conversation turns as ABM-L v1 format.

Format per turn: [ROLE|TYPE|topic|conf|M-date] <compressed body>
- ROLE: USER or ASSISTANT
- TYPE: F=fact, D=decision, P=preference, L=lesson, E=event, T=technical, Q=question, O=observation
- topic: coding/personal/memory/security/relationships/finance/health/work/general
- conf: 1-5 confidence (default 3)
- M-date: M2026-04 style

Compress aggressively: drop filler words, keep entities as @name, use pipes/arrows for relationships.
Output ONE line per turn, in order, NO preamble, NO commentary.`;

/**
 * Refine a batch of messages via LLM. Returns map of messageId → refined string.
 * On any failure, returns empty map (caller falls back to heuristic).
 */
export async function refineBatch(
  messages: MessageWithHints[],
  llmCall: RefineLlmFn,
): Promise<Map<number, string>> {
  if (messages.length === 0) return new Map();

  const userPrompt = messages
    .map((m, idx) => {
      const role = m.role.toUpperCase();
      const typeHint = m.type_hint ?? "?";
      const topicHint = m.topic_hint ?? "?";
      const emotionHint = m.emotion_hint ?? "?";
      const date = new Date(m.timestamp).toISOString().substring(0, 7); // YYYY-MM
      return `[TURN ${idx + 1}]\nrole=${role} type_hint=${typeHint} topic_hint=${topicHint} emotion_hint=${emotionHint} date=M${date}\ncontent: ${m.content}`;
    })
    .join("\n\n");

  const maxTokens = Math.max(1000, messages.length * 80); // ~80 tokens per refined line

  try {
    const result = await llmCall(SYSTEM_PROMPT, userPrompt, maxTokens);
    if (!result) {
      logWarn(TAG, `empty LLM response for batch of ${messages.length}, falling back to heuristic`);
      return new Map();
    }
    return parseBatchResponse(result, messages);
  } catch (err) {
    logWarn(TAG, `LLM refinement batch failed: ${err instanceof Error ? err.message : String(err)}`);
    return new Map();
  }
}

/**
 * Parse LLM output: one line per turn. Match line-by-line with input messages.
 * On parse failure for a specific turn, that turn is omitted (caller falls back).
 */
function parseBatchResponse(
  response: string,
  messages: MessageWithHints[],
): Map<number, string> {
  const lines = response
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0 && l.startsWith("["));

  const result = new Map<number, string>();

  for (let i = 0; i < messages.length && i < lines.length; i++) {
    const line = lines[i];
    const msg = messages[i];
    if (!line || !msg) continue;

    // Basic shape check: must start with [ and have at least one |
    if (!line.startsWith("[") || !line.includes("|")) continue;
    // Must close the bracket header
    if (!line.includes("]")) continue;

    result.set(msg.id, line);
  }

  logDebug(TAG, `LLM refinement parsed ${result.size}/${messages.length} lines`);
  return result;
}
