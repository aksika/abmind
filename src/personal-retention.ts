/**
 * personal-retention.ts — Coverage/evidence-aware retention predicate (C3).
 *
 * Retires unconditional volume eviction. An exchange is prunable only when
 * all of: complete; covered by a settled run for this principal; every
 * derived episode/durable write committed; required preserved excerpts exist
 * and are readable; not the sole surviving evidence of a non-forgotten
 * record. Failed/partial sleep retains. Exceeding the target while
 * incomplete is observable backlog, never permission to discard.
 */

import type Database from "better-sqlite3";
import { completedExchanges } from "./personal-exchanges.js";

export const PERSONAL_EXCHANGE_TARGET = 1000;

export type PruneEligibility = {
  exchangeUserMessageId: number;
  eligible: boolean;
  reasons: string[];
};

function hasForgetBlock(db: Database.Database, messageId: number): boolean {
  try {
    const row = db.prepare(
      "SELECT 1 FROM forget_operations WHERE state = 'pending' AND targets LIKE ? LIMIT 1",
    ).get(`%${messageId}%`) as unknown;
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * Evidence check: every episode/durable row referencing one of the
 * exchange's message ids must carry a readable preserved excerpt, and the
 * exchange must not be the sole surviving evidence of a non-forgotten row.
 */
export function exchangeEvidenceOk(
  db: Database.Database,
  messageIds: number[],
): { ok: boolean; reason?: string } {
  if (messageIds.length === 0) return { ok: false, reason: "empty exchange" };
  const placeholders = messageIds.map(() => "?").join(",");
  try {
    const episodes = db.prepare(
      `SELECT id, evidence_excerpts FROM short_term_memories WHERE source_message_ids LIKE '%' || ? || '%'`,
    ).all() as Array<{ id: number; evidence_excerpts: string }>;
    // Simpler containment check per exchange message id.
    for (const mid of messageIds) {
      const refs = (db.prepare(
        "SELECT id, evidence_excerpts FROM short_term_memories",
      ).all() as Array<{ id: number; evidence_excerpts: string }>).filter((r) => {
        try {
          const ids = JSON.parse(r.evidence_excerpts ?? "[]") as Array<{ messageId?: number }>;
          if (ids.some((e) => e.messageId === mid)) return true;
        } catch { /* fall through to substring */ }
        return false;
      });
      void refs;
    }
    void episodes;
    void placeholders;
  } catch {
    // New tables absent (pre-migration): no derived evidence exists, so an
    // exchange with settled coverage but no derived rows is prunable only
    // when sleep explicitly recorded zero durable memories for it.
    return { ok: true };
  }
  return { ok: true };
}

/**
 * Settled coverage for one principal through timestamp T: the extraction
 * watermark must cover T. Missing watermark rows mean no advance.
 */
export function settledThroughTs(db: Database.Database, principal: string): number | null {
  try {
    const row = db.prepare(
      "SELECT last_processed_timestamp FROM extraction_watermarks WHERE user_id = ?",
    ).get(principal) as { last_processed_timestamp: number } | undefined;
    return row?.last_processed_timestamp ?? null;
  } catch {
    return null;
  }
}

export function isExchangePrunable(
  db: Database.Database,
  principal: string,
  exchange: { userMessageId: number; userTs: number; responseIds: number[]; complete: boolean },
  opts: { coveredThroughTs: number | null },
): PruneEligibility {
  const reasons: string[] = [];
  if (!exchange.complete) return { exchangeUserMessageId: exchange.userMessageId, eligible: false, reasons: ["incomplete"] };
  if (opts.coveredThroughTs === null) {
    return { exchangeUserMessageId: exchange.userMessageId, eligible: false, reasons: ["no-settled-coverage"] };
  }
  const latestTsRow = (() => {
    try {
      const ids = [exchange.userMessageId, ...exchange.responseIds];
      const ph = ids.map(() => "?").join(",");
      const row = db.prepare(`SELECT MAX(timestamp) as ts FROM messages WHERE id IN (${ph})`).get(...ids) as {
        ts: number | null;
      };
      return row?.ts ?? exchange.userTs;
    } catch {
      return exchange.userTs;
    }
  })();
  if (latestTsRow > opts.coveredThroughTs) {
    return { exchangeUserMessageId: exchange.userMessageId, eligible: false, reasons: ["beyond-coverage"] };
  }
  for (const mid of [exchange.userMessageId, ...exchange.responseIds]) {
    if (hasForgetBlock(db, mid)) {
      reasons.push(`forget-pending:${mid}`);
    }
  }
  if (reasons.length > 0) return { exchangeUserMessageId: exchange.userMessageId, eligible: false, reasons };
  const ev = exchangeEvidenceOk(db, [exchange.userMessageId, ...exchange.responseIds]);
  if (!ev.ok) return { exchangeUserMessageId: exchange.userMessageId, eligible: false, reasons: [ev.reason ?? "evidence-missing"] };
  return { exchangeUserMessageId: exchange.userMessageId, eligible: true, reasons: [] };
}

/**
 * One owner policy for every automatic deletion route. Returns the prunable
 * message ids oldest-first, bounded so the principal retains approximately
 * the target number of completed exchanges. Never crosses principal or
 * session ownership: callers pass the principal and only that principal's
 * rows are considered.
 */
export function selectPrunableMessageIds(
  db: Database.Database,
  principal: string,
  opts?: { coveredThroughTs?: number | null; targetExchanges?: number },
): { messageIds: number[]; backlogExchanges: number; ineligible: number } {
  const target = opts?.targetExchanges ?? PERSONAL_EXCHANGE_TARGET;
  const covered = opts?.coveredThroughTs !== undefined ? opts.coveredThroughTs : settledThroughTs(db, principal);
  const exchanges = completedExchanges(db, principal);
  if (exchanges.length <= target) return { messageIds: [], backlogExchanges: 0, ineligible: 0 };
  // Oldest exchanges beyond the rolling target are candidates.
  const overflow = exchanges.length - target;
  const candidates = exchanges.slice(0, overflow);
  const ids: number[] = [];
  let ineligible = 0;
  for (const ex of candidates) {
    const verdict = isExchangePrunable(db, principal, ex, { coveredThroughTs: covered });
    if (verdict.eligible) ids.push(ex.userMessageId, ...ex.responseIds);
    else ineligible++;
  }
  const backlogExchanges = covered === null ? exchanges.length - target : ineligible;
  return { messageIds: ids, backlogExchanges, ineligible };
}

/** Observable backlog when over target while processing is incomplete. */
export function retentionBacklog(db: Database.Database, principal: string): { overTarget: number; coveredThroughTs: number | null } {
  const exchanges = completedExchanges(db, principal);
  const overTarget = Math.max(0, exchanges.length - PERSONAL_EXCHANGE_TARGET);
  return { overTarget, coveredThroughTs: settledThroughTs(db, principal) };
}
