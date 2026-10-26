/**
 * episode-grouping.ts — deterministic stepped-level episode grouping (#1942).
 *
 * Stepped sleep levels (budget/normal/ultimate) settle durable knowledge but
 * never grouped exchanges into episodes. This pass fills that gap inside
 * settlement's existing advance gate: it groups the primary principal's
 * completed, not-yet-grouped exchanges into topic episodes through the single
 * personal writer, oldest first, bounded per run so settled history catches
 * up over successive runs and covered exchanges become prunable.
 *
 * Exchange identity is C3's (`personal-exchanges.ts`), so every episode holds
 * exactly the message ids retention checks. A per-group data failure is
 * receipted and left ungrouped (therefore retained); a database/IO failure
 * escapes as systemic and settlement holds the watermark.
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { classifyTurn } from "../turn-classifier.js";
import { groupExchangesByTopic } from "../personal-episodes.js";
import type { EpisodeInput } from "../personal-episodes.js";
import { groupExchanges, isEligiblePersonalSession, loadPrincipalMessages } from "../personal-exchanges.js";
import type { PersonalExchange } from "../personal-exchanges.js";
import { isPersonalReady } from "../personal-schema.js";
import type { PrivateMemoryMutationStore } from "../private-memory-mutation-store.js";
import { writeReceipts } from "./receipts.js";

/** Completed exchanges grouped per stepped run. Bounded so a catch-up night
 *  stays within sleep's normal runtime; remaining history fills in over
 *  successive runs. Not configurable until runtime measurements demand it. */
export const STEPPED_GROUPING_EXCHANGE_LIMIT = 200;

/** Source excerpt bound, matching the C2/C3 grouping path. */
const MAX_EXCERPT_CHARS = 500;

/** SQLite chunk bound for `IN (...)` id lists. */
const ID_CHUNK = 500;

export interface EpisodeGroupingResult {
  /** Episodes written this run. */
  created: number;
  /** Groups that already existed (idempotent replay). */
  replayed: number;
  /** Per-group data failures receipted and left ungrouped. */
  rejected: number;
  /** Ungrouped complete exchanges at or below the ceiling after this run. */
  waiting: number;
}

export interface EpisodeGroupingInput {
  db: Database.Database;
  store: PrivateMemoryMutationStore;
  principal: string;
  memoryDir: string;
  runId: string;
  /** Greatest timestamp this run is authorized to cover. */
  ceiling: number;
  now: () => number;
  limit?: number;
}

/** A DB/IO failure is systemic: it is not one group's data problem, so the
 *  run must hold the watermark instead of receipting every group as invalid. */
function isDatabaseError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return err.name === "SqliteError" || (typeof code === "string" && code.startsWith("SQLITE_"));
}

/** User turns already bound to an immutable episode. This is the same
 *  bound-turn check C2 settlement uses, and it makes replay idempotent. */
function loadBoundUserTurns(db: Database.Database, principal: string): Set<number> {
  const bound = new Set<number>();
  try {
    const rows = db.prepare(
      "SELECT source_message_ids FROM short_term_memories WHERE user_id = ? AND json_valid(source_message_ids)",
    ).all(principal) as Array<{ source_message_ids: string }>;
    for (const row of rows) {
      const ids: unknown = JSON.parse(row.source_message_ids);
      if (!Array.isArray(ids)) continue;
      for (const id of ids) if (typeof id === "number") bound.add(id);
    }
  } catch (err) {
    // Episodes may predate the structural column in tests; an unreadable
    // set is not a binding proof, so the pass fails closed by throwing.
    throw new Error(`episode grouping cannot read existing episode sources (${err instanceof Error ? err.message : String(err)})`);
  }
  return bound;
}

/** Message content for one bounded id set (only the selected candidates). */
function loadContents(db: Database.Database, principal: string, ids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT id, content FROM messages WHERE user_id = ? AND id IN (${placeholders})`,
    ).all(principal, ...chunk) as Array<{ id: number; content: string }>;
    for (const row of rows) out.set(row.id, row.content);
  }
  return out;
}

interface CandidateSet {
  exchanges: PersonalExchange[];
  tsById: Map<number, number>;
}

/**
 * Complete exchanges in consumed-scope sessions whose latest message is at
 * or below the ceiling and whose user turn no episode holds. The set is not
 * restricted to `(watermark, ceiling]`: settled history below the watermark
 * is the catch-up backlog.
 */
function loadCandidates(db: Database.Database, principal: string, ceiling: number): CandidateSet {
  const rows = loadPrincipalMessages(db, principal).filter(r => isEligiblePersonalSession(r.session_id));
  const tsById = new Map<number, number>();
  for (const row of rows) tsById.set(row.id, row.timestamp);
  const bound = loadBoundUserTurns(db, principal);
  const exchanges = groupExchanges(rows).filter((exchange) => {
    if (!exchange.complete || bound.has(exchange.userMessageId)) return false;
    let latest = tsById.get(exchange.userMessageId) ?? 0;
    for (const id of exchange.responseIds) latest = Math.max(latest, tsById.get(id) ?? 0);
    return latest <= ceiling;
  });
  return { exchanges, tsById };
}

function groupOpId(runId: string, sourceIds: number[]): string {
  const digest = createHash("sha256").update(sourceIds.join(",")).digest("hex").slice(0, 16);
  return `${runId}/settlement/group-${digest}`;
}

/**
 * Group one settlement run's catch-up exchanges. Throws on anything systemic
 * (readiness, DB/IO, receipt persistence) so the caller holds the watermark;
 * per-group data failures are receipted and skipped.
 */
export function groupSteppedEpisodes(input: EpisodeGroupingInput): EpisodeGroupingResult {
  const { db, store, principal, memoryDir, runId, ceiling, now } = input;
  const limit = input.limit ?? STEPPED_GROUPING_EXCHANGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("episode grouping requires a positive exchange limit");
  if (!isPersonalReady(db)) throw new Error("episode grouping refused: dataset is not ready");

  const { exchanges, tsById } = loadCandidates(db, principal, ceiling);
  const selected = exchanges.slice(0, limit);
  const result: EpisodeGroupingResult = { created: 0, replayed: 0, rejected: 0, waiting: exchanges.length };
  if (selected.length === 0) return result;

  // One bounded read covers topic hints and evidence excerpts for this run.
  const sourceIds = selected.flatMap(e => [e.userMessageId, ...e.responseIds]);
  const contents = loadContents(db, principal, sourceIds);
  const byUser = new Map(selected.map(e => [e.userMessageId, e] as const));
  const descriptors = selected.map(e => ({
    userMessageId: e.userMessageId,
    userTs: e.userTs,
    sessionId: e.sessionId,
    topicHint: classifyTurn("user", contents.get(e.userMessageId) ?? "").topicHint ?? undefined,
  }));

  let groupedExchanges = 0;
  for (const group of groupExchangesByTopic(descriptors)) {
    const members = group.sourceMessageIds
      .map(id => byUser.get(id))
      .filter((e): e is PersonalExchange => e !== undefined);
    const groupSources = members.flatMap(e => [e.userMessageId, ...e.responseIds]);
    const reject = (reason: string): void => {
      result.rejected++;
      writeReceipts(memoryDir, [{
        runId,
        step: "settlement",
        principal,
        opId: groupOpId(runId, groupSources),
        op: "group",
        disposition: "rejected",
        reason,
        evidence: groupSources.join(","),
        at: now(),
      }]);
    };
    // Every source turn needs preserved text: an excerpt-less source can
    // never satisfy retention's evidence check, so creating the episode
    // would only make the exchange unprunable forever (A5 poison group).
    const evidence: EpisodeInput["evidenceExcerpts"] = [];
    let missingText: number | null = null;
    for (const id of groupSources) {
      const content = contents.get(id);
      if (content === undefined || content.trim() === "") {
        missingText = id;
        break;
      }
      evidence.push({ messageId: id, excerpt: content.slice(0, MAX_EXCERPT_CHARS), classification: 1 });
    }
    if (missingText !== null) {
      reject(`source message ${missingText} has no preservable text`);
      continue;
    }
    let endTs = group.startTs;
    for (const id of groupSources) endTs = Math.max(endTs, tsById.get(id) ?? group.startTs);
    try {
      const created = store.createPersonalEpisode({
        userId: principal,
        topic: group.topic,
        startTs: group.startTs,
        endTs,
        sessionIds: group.sessionIds,
        sourceMessageIds: groupSources,
        evidenceExcerpts: evidence,
        classification: 1,
        actorId: "sleep:episode-grouping",
      });
      if (created.replayed) result.replayed++;
      else result.created++;
      groupedExchanges += members.length;
    } catch (err) {
      if (isDatabaseError(err)) throw err;
      reject(err instanceof Error ? err.message : String(err));
    }
  }
  result.waiting = Math.max(0, exchanges.length - groupedExchanges);
  return result;
}
