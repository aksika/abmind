import { getAbmindEnv } from "./env-schema.js";
import type Database from "better-sqlite3";
import type { MessageRecord, SearchResult } from "./mem-types.js";
import type { ExtractedMemory, MemorySearchResult } from "./mem-types.js";
import { logWarn } from "./mem-logger.js";
import { classifyTurn } from "./turn-classifier.js";
import { EMOTION_BOOST_WEIGHT, recencyFactor, stripAccents, sanitizeFtsQuery, scoreExtractedRow, mapExtractedRow } from "./fts-utils.js";
import type { ExtractedFtsRow } from "./fts-utils.js";
import { sharedOrOwnedClause, effectiveMaxClassification } from "./memory-visibility.js";

/**
 * SQLite FTS5 full-text search index over conversation messages.
 *
 * Messages are inserted into the `messages` table; an AFTER INSERT trigger
 * automatically populates the `messages_fts` virtual table. Searches use
 * BM25 ranking via FTS5's built-in `rank` column.
 */
export class MemoryIndex {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Index a message for full-text search by inserting into the messages table.
   * The FTS trigger auto-indexes the content. Also runs the #348 turn classifier
   * to store cheap hints for later middle-tier rendering (classifier is pure
   * function, microseconds cost, runs regardless of CONTEXT_TIER_ENABLED flag).
   * Returns the inserted message id.
   */
  index(record: MessageRecord): number {
    const hints = classifyTurn(record.role, record.content);
    const stmt = this.db.prepare(
      `INSERT INTO messages (user_id, session_id, role, content, timestamp, platform_message_id, type_hint, topic_hint, emotion_hint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      record.userId,
      record.sessionId,
      record.role,
      record.content,
      record.timestamp,
      record.platformMessageId == null ? null : String(record.platformMessageId),
      hints.typeHint,
      hints.topicHint,
      hints.emotionHint,
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * Search messages by query using FTS5 BM25 ranking.
   *
   * FTS5 `rank` values are negative (more negative = more relevant),
   * so we ORDER BY rank ASC and convert to positive scores for output.
   */
  search(
    query: string,
    opts?: {
      userId?: string;
      startTime?: number;
      endTime?: number;
      limit?: number;
    },
    mode: "or" | "and" = "and",
  ): SearchResult[] {
    if (!query.trim()) return [];

    const sanitizedQuery = sanitizeFtsQuery(query, mode);
    if (!sanitizedQuery) return [];

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    // Use LIKE since messages_fts was dropped in migration v10
    const keywords = query.trim().split(/\s+/).filter(Boolean);
    if (keywords.length === 0) return [];
    const kwCondition = keywords.map(kw => {
      params.push(`%${kw}%`);
      return "m.content LIKE ?";
    }).join(mode === "or" ? " OR " : " AND ");
    conditions.push(`(${kwCondition})`);

    if (opts?.userId !== undefined) {
      conditions.push("m.user_id = ?");
      params.push(opts.userId);
    }
    if (opts?.startTime !== undefined) {
      conditions.push("m.timestamp >= ?");
      params.push(opts.startTime);
    }
    if (opts?.endTime !== undefined) {
      conditions.push("m.timestamp <= ?");
      params.push(opts.endTime);
    }

    const limit = opts?.limit ?? 20;
    params.push(limit);

    const sql = `
      SELECT m.id, m.user_id, m.session_id, m.role, m.content, m.timestamp, -1.0 as rank
      FROM messages m
      WHERE ${conditions.join(" AND ")}
      ORDER BY m.timestamp DESC
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number;
      user_id: string;
      session_id: string;
      role: string;
      content: string;
      timestamp: number;
      rank: number;
    }>;

    return rows.map((row) => ({
      record: {
        role: row.role as MessageRecord["role"],
        content: row.content,
        timestamp: row.timestamp,
        userId: row.user_id,
        sessionId: row.session_id,
      },
      score: Math.abs(Number(row.rank)),
    }));
  }

  /** Remove all indexed entries for a session. */
  removeSession(userId: string, sessionId: string): void {
    this.db
      .prepare("DELETE FROM messages WHERE user_id = ? AND session_id = ?")
      .run(userId, sessionId);
  }

  /**
   * Substring search — catches compound words that FTS5 prefix matching misses.
   * Uses accent-insensitive matching by fetching all messages for the chat
   * and filtering in JS with Unicode NFD normalization.
   * Tokens shorter than 3 chars are skipped. Results scored by number of matching tokens.
   */
  substringSearch(
    query: string,
    opts?: {
      userId?: string;
      startTime?: number;
      endTime?: number;
      limit?: number;
    },
    mode: "or" | "and" = "or",
  ): SearchResult[] {
    const tokens = query
      .replace(/[^\w\s\u00C0-\u024F]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3)
      .map((t) => t.toLowerCase());

    if (tokens.length === 0) return [];

    // Normalize tokens: strip accents for accent-insensitive matching
    const normalizedTokens = tokens.map((t) => stripAccents(t));

    // Fetch candidate messages from DB (filtered by chat/time only)
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts?.userId !== undefined) {
      conditions.push("user_id = ?");
      params.push(opts.userId);
    }
    if (opts?.startTime !== undefined) {
      conditions.push("timestamp >= ?");
      params.push(opts.startTime);
    }
    if (opts?.endTime !== undefined) {
      conditions.push("timestamp <= ?");
      params.push(opts.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT id, user_id, session_id, role, content, timestamp
      FROM messages
      ${whereClause}
      ORDER BY timestamp DESC
    `;

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number;
      user_id: string;
      session_id: string;
      role: string;
      content: string;
      timestamp: number;
    }>;

    // Score by number of matching tokens (accent-insensitive)
    const limit = opts?.limit ?? 20;
    const results: SearchResult[] = [];

    for (const row of rows) {
      const normalizedContent = stripAccents(row.content.toLowerCase());
      const matchCount = normalizedTokens.filter((t) => normalizedContent.includes(t)).length;
      if (matchCount === 0) continue;
      if (mode === "and" && matchCount < normalizedTokens.length) continue;

      results.push({
        record: {
          role: row.role as MessageRecord["role"],
          content: row.content,
          timestamp: row.timestamp,
          userId: row.user_id,
          sessionId: row.session_id,
        },
        score: matchCount / normalizedTokens.length,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /** Remove oldest entries for a chat beyond the limit, keeping the most recent. */
  prune(userId: string, maxMessages: number): void {
    this.db
      .prepare(
        `DELETE FROM messages WHERE user_id = ? AND id NOT IN (
           SELECT id FROM messages WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?
         )`,
      )
      .run(userId, userId, maxMessages);
  }

  /**
   * Search extracted memories by English content using FTS5 on extracted_memories_fts.
   *
   * Joins with extracted_memories for metadata. Supports userId, time range,
   * and limit filters. Returns MemorySearchResult[] with tier="extracted".
   * Returns empty array on error.
   */
  searchExtracted(
    query: string,
    opts?: { userId?: string; startTime?: number; endTime?: number; limit?: number; maxClassification?: number },
    mode: "or" | "and" = "and",
  ): MemorySearchResult[] {
    try {
      if (!query.trim()) return [];

      const sanitizedQuery = sanitizeFtsQuery(query, mode);
      if (!sanitizedQuery) return [];
      // A lower-level caller may omit the optional userId, but that must be a
      // fail-closed query rather than an implicit shared-memory principal.
      const principalUserId = opts?.userId;
      if (typeof principalUserId !== "string" || principalUserId.trim() === "") return [];

      const conditions: string[] = ["extracted_memories_fts MATCH ?"];
      const params: (string | number)[] = [sanitizedQuery];

      // #1658: the shared visibility predicate with the permanent class-3
      // ceiling (results unchanged — the old code already capped at 2).
      const vis = sharedOrOwnedClause("em", principalUserId, effectiveMaxClassification(opts?.maxClassification));
      conditions.push(vis.sql);
      params.push(...vis.params);
      if (opts?.startTime !== undefined) {
        conditions.push("em.created_at >= ?");
        params.push(opts.startTime);
      }
      if (opts?.endTime !== undefined) {
        conditions.push("em.created_at <= ?");
        params.push(opts.endTime);
      }

      const limit = opts?.limit ?? 20;
      params.push(limit);

      const sql = `
        SELECT em.id, em.content_en, em.content_original, em.memory_type,
               em.created_at, em.preserve_original, em.emotion_score,
               em.recall_count, em.relevance_score, em.source_message_ids,
               em.trust, em.integrity, em.credibility, em.classification, em.tier, rank
        FROM extracted_memories em
        JOIN extracted_memories_fts ON extracted_memories_fts.rowid = em.id
        WHERE ${conditions.join(" AND ")}
        ORDER BY rank * (1.0 + 0.1 * COALESCE(em.recall_count, 0))
                      * CASE WHEN COALESCE(em.relevance_score, 0) > 0 THEN 1.2 ELSE 1.0 END
                      / (0.5 + 0.5 * COALESCE(em.trust, 0) / 3.0)
                      * CASE WHEN COALESCE(em.credibility, 6) <= 2 THEN 0.8 ELSE 1.0 END
               ASC
        LIMIT ?
      `;

      const rows = this.db.prepare(sql).all(...params) as ExtractedFtsRow[];

      return rows.map((row) => mapExtractedRow(row, scoreExtractedRow(row, Math.abs(row.rank))));
    } catch (err) {
      logWarn("memory-index", `searchExtracted failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** Bump recall_count and last_recalled_at for authorized extracted IDs. */
  bumpRecallCount(ids: number[], userId?: string): void {
    if (ids.length === 0) return;
    if (userId !== undefined && userId.trim() === "") return;
    try {
      const now = Date.now();
      const stmt = this.db.prepare(
        userId !== undefined
          ? "UPDATE extracted_memories SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ? AND user_id = ?"
          : "UPDATE extracted_memories SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?",
      );
      for (const id of ids) userId !== undefined ? stmt.run(now, id, userId) : stmt.run(now, id);
    } catch (err) {
      logWarn("memory-index", `bumpRecallCount failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Bump cited_count for recalled memories the agent actually used. */
  bumpCitedCount(ids: number[], userId?: string): void {
    if (ids.length === 0) return;
    if (userId !== undefined && userId.trim() === "") return;
    try {
      const stmt = this.db.prepare(
        userId !== undefined
          ? "UPDATE extracted_memories SET cited_count = cited_count + 1 WHERE id = ? AND user_id = ?"
          : "UPDATE extracted_memories SET cited_count = cited_count + 1 WHERE id = ?",
      );
      for (const id of ids) userId !== undefined ? stmt.run(id, userId) : stmt.run(id);
    } catch (err) {
      logWarn("memory-index", `bumpCitedCount failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Bump rejected_count for recalled memories the user rejected (frustration/negative emoji). */
  bumpRejectedCount(ids: number[], userId?: string): void {
    if (ids.length === 0) return;
    if (userId !== undefined && userId.trim() === "") return;
    try {
      const stmt = this.db.prepare(
        userId !== undefined
          ? "UPDATE extracted_memories SET rejected_count = rejected_count + 1 WHERE id = ? AND user_id = ?"
          : "UPDATE extracted_memories SET rejected_count = rejected_count + 1 WHERE id = ?",
      );
      for (const id of ids) userId !== undefined ? stmt.run(id, userId) : stmt.run(id);
    } catch (err) {
      logWarn("memory-index", `bumpRejectedCount failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Index an extracted memory in the FTS5 indexes.
   * Indexes content_en into extracted_memories_fts (porter).
   * Trigram indexes are maintained by SQLite triggers.
   */
  indexExtractedMemory(memory: ExtractedMemory & { id: number }): void {
    try {
      this.db
        .prepare("INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (?, ?)")
        .run(memory.id, memory.content_en);
    } catch (err) {
      logWarn("memory-index", `indexExtractedMemory failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

}
