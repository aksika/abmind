import type Database from "better-sqlite3";
import type { MemoryConfig } from "./memory-config.js";
import type { MessageRecord } from "./mem-types.js";
import type { MemoryIndex } from "./memory-index.js";
import { logError, logWarn, logTrace } from "./mem-logger.js";
import { scanForInjection } from "./injection-scanner.js";
import { redactSecrets } from "./redact-secrets.js";

const TAG = "message-store";

/**
 * Roles whose content is scanned for prompt injection at store time.
 * Allowlist (not blocklist) — new roles default to trusted-skip.
 * Untrusted input must opt in explicitly.
 *
 * - user: untrusted input from any platform adapter
 * - assistant: bridge's own LLM output — trusted transport
 * - compaction: derivative of already-scanned user messages — no new attack surface
 */
const SCANNED_ROLES = new Set<MessageRecord["role"]>(["user"]);

/** Handles message recording, loading, and emotion score updates. */
export class MessageStore {
  constructor(
    private readonly db: Database.Database,
    private readonly config: MemoryConfig,
    private readonly memoryIndex: MemoryIndex,
  ) {}

  private writeCounter = 0;
  private diskBudgetCallback: (() => void) | null = null;
  /** Count of messages rejected by the injection scanner since process start. Exposed via getStats(). */
  rejectedByScanner = 0;

  /** Register a callback to run disk budget enforcement periodically. */
  setDiskBudgetCallback(fn: () => void): void { this.diskBudgetCallback = fn; }

  /** Record a conversation message to FTS index + optional backup. Never throws. */
  recordMessage(record: MessageRecord): void {
    try {
      if (!record.content.trim()) return;

      // #505 Stage A: skip system/test messages that should never become memories
      if (/\[NO_REPLY\]|connection test/i.test(record.content)) return;

      // #517: skip tool output / structured data blobs (assistant only, >200 chars)
      if (record.role === "assistant" && /^\s*[\[{]/.test(record.content) && record.content.length > 200) return;

      if (SCANNED_ROLES.has(record.role)) {
        const scan = scanForInjection(record.content);
        if (!scan.safe) {
          this.rejectedByScanner++;
          logError(
            TAG,
            `Injection blocked in ${record.role} message (flags: ${scan.flags.map(f => f.category).join(", ")}, user=${record.userId}): ${redactSecrets(record.content)}`,
          );
          return;
        }
      }

      this.memoryIndex.index(record);
      logTrace(TAG, `recorded ${record.role} msg (user=${record.userId}, ${record.content.length} chars)`);

      if (this.config.maxMessagesPerChat > 0) {
        this.memoryIndex.prune(record.userId, this.config.maxMessagesPerChat);
      }

      this.writeCounter++;
      if (this.writeCounter % 100 === 0) this.diskBudgetCallback?.();
    } catch (err) {
      logError(TAG, "Failed to record message", err);
    }
  }

  /** Load the most recent N messages from a session. */
  loadRecentMessages(userId: string, sessionId: string, count: number): MessageRecord[] {
    try {
      const rows = this.db.prepare(
        "SELECT role, content, timestamp, user_id, session_id AS sessionId FROM messages WHERE user_id = ? AND session_id = ? ORDER BY timestamp DESC LIMIT ?",
      ).all(userId, sessionId, count) as MessageRecord[];
      return rows.reverse();
    } catch (err) {
      logError(TAG, `Failed to load recent messages for chat ${userId} session ${sessionId}`, err);
      return [];
    }
  }

  /** Update emotion_score and optionally emotion_tags on a message by platform ID. Returns true if updated. */
  updateEmotionByPlatformId(
    userId: string | string,
    platformMessageId: number,
    score: number,
    editMemoryFn: (params: { messageId: number; userId: string; emotionScore: number; emotionTags?: string }) => void,
    tag?: string,
  ): boolean {
    try {
      const result = this.db.prepare(
        "UPDATE messages SET emotion_score = ? WHERE user_id = ? AND platform_message_id = ?",
      ).run(score, userId, platformMessageId);
      if (result.changes === 0) return false;
      editMemoryFn({
        messageId: platformMessageId,
        userId: userId,
        emotionScore: score,
        emotionTags: tag,
      });
      return true;
    } catch (err) {
      logError(TAG, "Failed to update emotion score", err);
      return false;
    }
  }

  /** Get the timestamp of the most recent user message (optionally excluding system markers). */
  getLastMessageTimestamp(excludeSystem = false, sessionTypeFilter?: string): number {
    try {
      let sql = excludeSystem
        ? "SELECT MAX(timestamp) as ts FROM messages WHERE content NOT LIKE '%[SYSTEM%'"
        : "SELECT MAX(timestamp) as ts FROM messages WHERE role = 'user'";
      if (sessionTypeFilter) sql += ` AND session_id LIKE '%_${sessionTypeFilter}_%'`;
      const row = this.db.prepare(sql).get() as { ts: number | null } | undefined;
      return row?.ts ?? 0;
    } catch (err) { logWarn(TAG, `getLastMessageTimestamp failed: ${err instanceof Error ? err.message : String(err)}`); return 0; }
  }

  /** Get recent messages since a timestamp, ordered newest first. */
  getMessagesSince(sinceTimestamp: number, limit: number): Array<{ role: string; content: string; timestamp: number }> {
    try {
      return this.db.prepare(
        "SELECT role, content, timestamp FROM messages WHERE timestamp > ? ORDER BY timestamp DESC LIMIT ?",
      ).all(sinceTimestamp, limit) as Array<{ role: string; content: string; timestamp: number }>;
    } catch (err) { logWarn(TAG, `query failed: ${err instanceof Error ? err.message : String(err)}`); return []; }
  }

  /** Get recent conversation for a user, ordered oldest first (ready to replay as turns). */
  getRecentConversation(userId: string, since: number, limit: number): Array<{ role: string; content: string; timestamp: number }> {
    try {
      return this.db.prepare(
        "SELECT role, content, timestamp FROM messages WHERE user_id = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT ?",
      ).all(userId, since, limit) as Array<{ role: string; content: string; timestamp: number }>;
    } catch (err) { logWarn(TAG, `query failed: ${err instanceof Error ? err.message : String(err)}`); return []; }
  }

  /** Get recent extracted memories (English content), newest first. */
  getRecentExtractedMemories(limit: number): string[] {
    try {
      const rows = this.db.prepare(
        "SELECT content_en FROM extracted_memories ORDER BY created_at DESC LIMIT ?",
      ).all(limit) as Array<{ content_en: string }>;
      return rows.map(r => r.content_en);
    } catch (err) { logWarn(TAG, `query failed: ${err instanceof Error ? err.message : String(err)}`); return []; }
  }

  /** Get all extracted memories with attributes (for dashboard visualization). */
  getAllExtractedMemories(): Array<Record<string, unknown>> {
    try {
      return this.db.prepare(
        `SELECT id, content_en, content_original, memory_type, created_at, emotion_score,
                recall_count, relevance_score, classification, trust, integrity, credibility,
                CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END as has_embedding
         FROM extracted_memories ORDER BY created_at DESC`
      ).all() as Array<Record<string, unknown>>;
    } catch (err) {
      logWarn(TAG, `getAllExtractedMemories failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** Get distinct user IDs from messages. */
  getDistinctUserIds(): string[] {
    try {
      return (this.db.prepare("SELECT DISTINCT user_id FROM messages ORDER BY user_id").all() as Array<{ user_id: string }>)
        .map(r => r.user_id);
    } catch (err) { logWarn(TAG, `query failed: ${err instanceof Error ? err.message : String(err)}`); return []; }
  }
}
