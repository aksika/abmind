/**
 * personal-episodes.ts — Topic episode layer (C2) behind the single personal
 * writer (#1930 M2).
 *
 * One record is one coherent topic discussion in one bounded conversation
 * period. Later returns to a topic create new linked episodes; replay never
 * duplicates accepted grouping. Content is append-only; prominence decay is a
 * separate mutable field. Classification/sealed projections are preserved in
 * every layer.
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { isPersonalReady } from "./personal-schema.js";

export type AuthorityClass = "user_statement" | "confirmed_decision" | "agent_proposal" | "inference";

export type EpisodeInput = {
  userId: string;
  topic: string;
  startTs: number;
  endTs: number;
  sessionIds: string[];
  sourceMessageIds: number[];
  outcomes?: string | null;
  unresolved?: string | null;
  evidenceExcerpts: Array<{ messageId: number; excerpt: string; classification: number }>;
  classification?: number;
  prevEpisodeId?: number | null;
  actorId: string;
};

export type EpisodeRow = {
  id: number;
  user_id: string;
  topic: string;
  start_ts: number;
  end_ts: number;
  session_ids: string;
  source_message_ids: string;
  grouping_hash: string;
  outcomes: string | null;
  unresolved: string | null;
  evidence_excerpts: string;
  prominence: number;
  prev_episode_id: number | null;
  next_episode_id: number | null;
  classification: number;
};

/** Stable grouping hash: owner + ordered source ids + topic + span. */
export function groupingHash(userId: string, sourceMessageIds: number[], topic: string, startTs: number, endTs: number): string {
  const ordered = [...sourceMessageIds].sort((a, b) => a - b);
  return createHash("sha256")
    .update(JSON.stringify({ userId, ordered, topic, startTs, endTs }))
    .digest("hex")
    .slice(0, 32);
}

function requireReady(db: Database.Database): void {
  if (!isPersonalReady(db)) {
    const row = db.prepare("SELECT state, reason FROM personal_model_state WHERE singleton = 1").get() as
      | { state: string; reason: string | null }
      | undefined;
    throw new Error(`personal serving refused: dataset is ${row?.state ?? "unknown"} (${row?.reason ?? "no reason"})`);
  }
}

function sealedExcerptOk(excerpt: string, classification: number): boolean {
  // Sealed exact values never enter plaintext excerpts. Callers pass only
  // safe labels; an empty excerpt is omitted upstream rather than stored.
  void classification;
  return excerpt.trim().length > 0;
}

/**
 * Create one episode through the single personal writer path. Sleep
 * proposals, adapters, retention and restore call this rather than writing
 * rows directly. Idempotent on (user_id, grouping_hash): replay returns the
 * existing episode without duplicating.
 */
export function createEpisode(
  db: Database.Database,
  input: EpisodeInput,
): { id: number; replayed: boolean } {
  requireReady(db);
  if (!input.userId.trim()) throw new Error("episode requires an owner principal");
  if (!input.topic.trim()) throw new Error("episode requires a topic");
  if (input.sourceMessageIds.length === 0) throw new Error("episode requires source turns");
  if (input.endTs < input.startTs) throw new Error("episode end precedes start");
  const hash = groupingHash(input.userId, input.sourceMessageIds, input.topic, input.startTs, input.endTs);
  const existing = db.prepare(
    "SELECT id FROM short_term_memories WHERE user_id = ? AND grouping_hash = ?",
  ).get(input.userId, hash) as { id: number } | undefined;
  if (existing) return { id: existing.id, replayed: true };

  const excerpts = input.evidenceExcerpts.filter((e) => sealedExcerptOk(e.excerpt, e.classification));
  if (excerpts.length === 0) throw new Error("episode requires at least one preserved excerpt before raw pruning");

  const now = Date.now();
  const classification = input.classification ?? 1;
  const txn = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO short_term_memories
        (user_id, topic, start_ts, end_ts, session_ids, source_message_ids, grouping_hash,
         outcomes, unresolved, evidence_excerpts, prominence, prev_episode_id, classification, encrypted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0, ?, ?, 0, ?, ?)`,
    ).run(
      input.userId,
      input.topic,
      input.startTs,
      input.endTs,
      JSON.stringify(input.sessionIds),
      JSON.stringify([...input.sourceMessageIds].sort((a, b) => a - b)),
      hash,
      input.outcomes ?? null,
      input.unresolved ?? null,
      JSON.stringify(excerpts),
      input.prevEpisodeId ?? null,
      classification,
      now,
      now,
    );
    const id = Number(result.lastInsertRowid);
    db.prepare(
      "INSERT OR IGNORE INTO personal_grouping_ledger (user_id, grouping_hash, episode_id, created_at) VALUES (?, ?, ?, ?)",
    ).run(input.userId, hash, id, now);
    if (input.prevEpisodeId != null) {
      db.prepare("UPDATE short_term_memories SET next_episode_id = ? WHERE id = ? AND user_id = ?").run(
        id,
        input.prevEpisodeId,
        input.userId,
      );
    }
    return id;
  });
  const id = txn();
  return { id, replayed: false };
}

export function getEpisode(db: Database.Database, userId: string, episodeId: number): EpisodeRow | undefined {
  return db.prepare("SELECT * FROM short_term_memories WHERE id = ? AND user_id = ?").get(episodeId, userId) as
    | EpisodeRow
    | undefined;
}

export function listEpisodes(
  db: Database.Database,
  userId: string,
  opts?: { topic?: string; limit?: number },
): EpisodeRow[] {
  if (opts?.topic) {
    return db.prepare(
      "SELECT * FROM short_term_memories WHERE user_id = ? AND topic = ? ORDER BY start_ts ASC LIMIT ?",
    ).all(userId, opts.topic, opts.limit ?? 50) as EpisodeRow[];
  }
  return db.prepare("SELECT * FROM short_term_memories WHERE user_id = ? ORDER BY start_ts ASC LIMIT ?").all(
    userId,
    opts?.limit ?? 50,
  ) as EpisodeRow[];
}

/**
 * Prominence decay lowers retrieval prominence and never rewrites content.
 * Bounded 0..1, deterministic for tests: prominence *= factor.
 */
export function decayEpisodeProminence(db: Database.Database, userId: string, episodeId: number, factor = 0.95): number {
  const row = getEpisode(db, userId, episodeId);
  if (!row) throw new Error("episode not found");
  const next = Math.max(0, Math.min(1, row.prominence * factor));
  db.prepare("UPDATE short_term_memories SET prominence = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(
    next,
    Date.now(),
    episodeId,
    userId,
  );
  return next;
}

/**
 * Deterministic topic grouping for one bounded conversation period.
 * Groups consecutive exchanges by session + topic hint + time proximity;
 * topic switches and later returns start new episodes. Pair count/time are
 * not caps: long discussions split only at coherent topic boundaries.
 */
export function groupExchangesByTopic(
  exchanges: Array<{ userMessageId: number; userTs: number; sessionId: string; topicHint?: string }>,
  opts?: { gapMs?: number },
): Array<{ topic: string; startTs: number; endTs: number; sessionIds: string[]; sourceMessageIds: number[] }> {
  const gapMs = opts?.gapMs ?? 60 * 60 * 1000;
  const groups: Array<{ topic: string; startTs: number; endTs: number; sessionIds: string[]; sourceMessageIds: number[] }> = [];
  let current: { topic: string; startTs: number; endTs: number; sessionIds: string[]; sourceMessageIds: number[] } | null = null;
  for (const ex of exchanges) {
    const topic = (ex.topicHint ?? "general").trim() || "general";
    if (
      !current ||
      current.topic !== topic ||
      current.sessionIds[current.sessionIds.length - 1] !== ex.sessionId ||
      ex.userTs - current.endTs > gapMs
    ) {
      if (current) groups.push(current);
      current = { topic, startTs: ex.userTs, endTs: ex.userTs, sessionIds: [ex.sessionId], sourceMessageIds: [ex.userMessageId] };
    } else {
      current.endTs = ex.userTs;
      if (!current.sessionIds.includes(ex.sessionId)) current.sessionIds.push(ex.sessionId);
      current.sourceMessageIds.push(ex.userMessageId);
    }
  }
  if (current) groups.push(current);
  return groups;
}
