/**
 * context-engine.ts — DB-backed context window management.
 * Pure data layer: reads/writes context state. No LLM calls.
 * Agentbridge orchestrates compaction decisions and LLM summarization.
 */

import type Database from "better-sqlite3";
import { logDebug, logTrace } from "./mem-logger.js";

const TAG = "context-engine";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ContextMessage {
  id: number;
  role: string;
  content: string;
  timestamp: number;
  classification?: number;
}

export interface ContextSummary {
  id: number;
  chatId: string;
  depth: number;
  content: string;
  tokenEstimate: number;
  sourceMessageStart: number;
  sourceMessageEnd: number;
  classification: number;
  model: string | null;
  createdAt: number;
}

export interface ContextSnapshot {
  summaries: ContextSummary[];
  messages: ContextMessage[];
  estimatedTokens: number;
  pendingCompaction: boolean;
}

export interface CompactionChunk {
  messages: ContextMessage[];
  sourceStart: number;
  sourceEnd: number;
  classification: number;
  chunkTokens: number;
  totalTokens: number;
}

export interface ContextWatermark {
  chatId: string;
  watermarkMessageId: number;
  compactionCount: number;
  lastCompactedAt: number | null;
  lastFailedAt: number | null;
  pendingCompaction: number;
  model: string | null;
  tokenEstimate: number | null;
}

// ── Constants (exported for abtars to reference) ────────────────────────

export const CHARS_PER_TOKEN = 4;
export const TAIL_TOKENS = 20_000;
export const TAIL_MIN_MESSAGES = 12;
export const MAX_CHUNK_TOKENS = 40_000;
export const CONDENSATION_THRESHOLD_TOKENS = 8_000;
export const COMPACT_TRIGGER_PCT = parseFloat(process.env["COMPACT_TRIGGER_PCT"] ?? "60") / 100;
export const COOLDOWN_MS = 10 * 60 * 1000;

// ── Context Engine ───────────────────────────────────────────────────────────

export class ContextEngine {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Load current context state: summaries + messages from watermark. */
  buildContext(chatId: string): ContextSnapshot {
    const wm = this.getWatermark(chatId);
    const summaries = this.getSummaries(chatId);
    const messages = this.getMessagesFrom(chatId, wm?.watermarkMessageId ?? 0);
    const summaryTokens = summaries.reduce((s, x) => s + x.tokenEstimate, 0);
    const messageTokens = messages.reduce((s, m) => s + Math.ceil(m.content.length / CHARS_PER_TOKEN), 0);

    return {
      summaries,
      messages,
      estimatedTokens: summaryTokens + messageTokens,
      pendingCompaction: (wm?.pendingCompaction ?? 0) === 1,
    };
  }

  /** Expose DB for tier renderer (needs to load hint columns). */
  getDb(): Database.Database {
    return this.db;
  }

  /** Identify the chunk to compact. Returns null if nothing to compact. */
  getCompactionChunk(chatId: string, tokenBudget: number): CompactionChunk | null {
    const wm = this.getWatermark(chatId);

    // Cooldown check
    if (wm?.lastFailedAt && (Date.now() - wm.lastFailedAt) < COOLDOWN_MS) return null;

    const messages = this.getMessagesFrom(chatId, wm?.watermarkMessageId ?? 0);
    if (messages.length <= TAIL_MIN_MESSAGES) return null;

    const msgTokens = messages.map(m => Math.ceil(m.content.length / CHARS_PER_TOKEN));
    const totalTokens = msgTokens.reduce((s, t) => s + t, 0);

    // Find tail boundary
    let tailTokens = 0;
    let tailStart = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (tailTokens + msgTokens[i]! > TAIL_TOKENS && (messages.length - i) >= TAIL_MIN_MESSAGES) break;
      tailTokens += msgTokens[i]!;
      tailStart = i;
    }

    // Last user message must be in tail
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") {
        if (i < tailStart) tailStart = i;
        break;
      }
    }

    if (tailStart <= 0) return null;

    // Dynamic chunk: min(all outside tail, MAX_CHUNK_TOKENS)
    let chunkEnd = 0;
    let chunkTokens = 0;
    for (let i = 0; i < tailStart; i++) {
      if (chunkTokens + msgTokens[i]! > MAX_CHUNK_TOKENS && chunkEnd > 0) break;
      chunkTokens += msgTokens[i]!;
      chunkEnd = i + 1;
    }
    if (chunkEnd <= 0) return null;

    // Don't split tool groups
    while (chunkEnd > 1 && messages[chunkEnd - 1]?.role === "tool") chunkEnd--;

    const chunk = messages.slice(0, chunkEnd);
    // Classification: max of non-SECRET sources
    const maxClass = chunk.reduce((max, m) => {
      const c = m.classification ?? 1;
      return c < 3 && c > max ? c : max;
    }, 1);

    logDebug(TAG, `compaction chunk: ${chunkEnd} msgs, ${chunkTokens} tokens (total=${totalTokens}, tail starts at ${tailStart})`);
    logTrace(TAG, `chunk range: msg[0..${chunkEnd - 1}], classification=${maxClass}`);

    return {
      messages: chunk,
      sourceStart: chunk[0]!.id,
      sourceEnd: chunk[chunk.length - 1]!.id,
      classification: maxClass,
      chunkTokens,
      totalTokens,
    };
  }

  /** Store a compaction summary and advance the watermark. */
  persistSummary(chatId: string, content: string, tokenEstimate: number, sourceStart: number, sourceEnd: number, classification: number, model?: string | null): number {
    logDebug(TAG, `persistSummary: chatId=${chatId} sourceRange=${sourceStart}-${sourceEnd} tokens=${tokenEstimate} class=${classification}`);
    const stmt = this.db.prepare(`
      INSERT INTO context_summaries (chat_id, depth, content, token_estimate, source_message_start, source_message_end, classification, model, created_at)
      VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(chatId, content, tokenEstimate, sourceStart, sourceEnd, classification, model ?? null, Date.now());
    this.advanceWatermark(chatId, sourceEnd + 1, model ?? null, tokenEstimate);
    return Number(result.lastInsertRowid);
  }

  /** Store a condensed summary (depth > 0) and archive the source leaves. */
  persistCondensedSummary(chatId: string, content: string, tokenEstimate: number, sourceLeafIds: number[], model?: string | null): number {
    const leaves = this.getSummaries(chatId).filter(s => sourceLeafIds.includes(s.id));
    if (leaves.length === 0) return -1;
    const sourceStart = Math.min(...leaves.map(l => l.sourceMessageStart));
    const sourceEnd = Math.max(...leaves.map(l => l.sourceMessageEnd));
    const maxDepth = Math.max(...leaves.map(l => l.depth));
    const classification = Math.max(...leaves.map(l => l.classification));

    const stmt = this.db.prepare(`
      INSERT INTO context_summaries (chat_id, depth, content, token_estimate, source_message_start, source_message_end, classification, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(chatId, maxDepth + 1, content, tokenEstimate, sourceStart, sourceEnd, classification, model ?? null, Date.now());

    // Archive source leaves
    const ids = sourceLeafIds.map(() => "?").join(",");
    this.db.prepare(`UPDATE context_summaries SET archived = 1 WHERE id IN (${ids})`).run(...sourceLeafIds);

    return Number(result.lastInsertRowid);
  }

  /** Archive all summaries for a chat (/reset). */
  archiveContext(chatId: string): void {
    this.db.prepare("UPDATE context_summaries SET archived = 1 WHERE chat_id = ? AND archived = 0").run(chatId);
    const latest = this.db.prepare("SELECT MAX(id) as maxId FROM messages WHERE session_id = ?").get(chatId) as { maxId: number | null } | undefined;
    if (latest?.maxId) {
      this.advanceWatermark(chatId, latest.maxId + 1, null, null);
    }
  }

  /** Check if condensation is needed. */
  needsCondensation(chatId: string): { needed: boolean; leafIds: number[]; totalTokens: number } {
    const leaves = this.getSummaries(chatId).filter(s => s.depth === 0);
    const totalTokens = leaves.reduce((s, x) => s + x.tokenEstimate, 0);
    return { needed: totalTokens > CONDENSATION_THRESHOLD_TOKENS, leafIds: leaves.map(l => l.id), totalTokens };
  }

  /** Set pending compaction flag. */
  setPendingCompaction(chatId: string): void {
    this.db.prepare(`
      INSERT INTO context_watermarks (chat_id, watermark_message_id, pending_compaction)
      VALUES (?, 0, 1)
      ON CONFLICT(chat_id) DO UPDATE SET pending_compaction = 1
    `).run(chatId);
  }

  /** Record a failed compaction attempt (for cooldown). */
  setLastFailed(chatId: string): void {
    this.db.prepare(`
      INSERT INTO context_watermarks (chat_id, watermark_message_id, last_failed_at)
      VALUES (?, 0, ?)
      ON CONFLICT(chat_id) DO UPDATE SET last_failed_at = excluded.last_failed_at
    `).run(chatId, Date.now());
  }

  /** Get watermark for GC coordination. Returns MAX_INT if no watermark (protect all). */
  getMinWatermarkForGC(): number {
    const row = this.db.prepare("SELECT MIN(watermark_message_id) as minWm FROM context_watermarks").get() as { minWm: number | null } | undefined;
    return row?.minWm ?? 2147483647;
  }

  // ── Getters ────────────────────────────────────────────────────────────────

  getWatermark(chatId: string): ContextWatermark | null {
    const row = this.db.prepare("SELECT * FROM context_watermarks WHERE chat_id = ?").get(chatId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      chatId: row.chat_id as string,
      watermarkMessageId: row.watermark_message_id as number,
      compactionCount: row.compaction_count as number,
      lastCompactedAt: row.last_compacted_at as number | null,
      lastFailedAt: row.last_failed_at as number | null,
      pendingCompaction: row.pending_compaction as number,
      model: row.model as string | null,
      tokenEstimate: row.token_estimate as number | null,
    };
  }

  getSummaries(chatId: string): ContextSummary[] {
    const rows = this.db.prepare(
      "SELECT * FROM context_summaries WHERE chat_id = ? AND archived = 0 ORDER BY created_at"
    ).all(chatId) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as number,
      chatId: r.chat_id as string,
      depth: r.depth as number,
      content: r.content as string,
      tokenEstimate: r.token_estimate as number,
      sourceMessageStart: r.source_message_start as number,
      sourceMessageEnd: r.source_message_end as number,
      classification: r.classification as number,
      model: r.model as string | null,
      createdAt: r.created_at as number,
    }));
  }

  getMessagesFrom(chatId: string, fromMessageId: number): ContextMessage[] {
    const rows = this.db.prepare(
      "SELECT id, role, content, timestamp FROM messages WHERE session_id = ? AND id >= ? ORDER BY id"
    ).all(chatId, fromMessageId) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as number,
      role: r.role as string,
      content: r.content as string,
      timestamp: r.timestamp as number,
    }));
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private advanceWatermark(chatId: string, watermarkMessageId: number, model: string | null, tokenEstimate: number | null): void {
    this.db.prepare(`
      INSERT INTO context_watermarks (chat_id, watermark_message_id, compaction_count, last_compacted_at, model, token_estimate)
      VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        watermark_message_id = excluded.watermark_message_id,
        compaction_count = compaction_count + 1,
        last_compacted_at = excluded.last_compacted_at,
        model = excluded.model,
        token_estimate = excluded.token_estimate,
        pending_compaction = 0
    `).run(chatId, watermarkMessageId, Date.now(), model, tokenEstimate);
  }
}
