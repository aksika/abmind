/**
 * personal-exchanges.ts — Exchange identity for the C3 retention contract (#1930).
 *
 * An exchange is one user turn plus its associated assistant response
 * message(s) within the same principal and session. Retained tool or
 * multi-part rows belong to the producing exchange and never each consume
 * another exchange. Counting is per authenticated principal across eligible
 * personal sessions; operational-domain input is outside the budget.
 */

import type Database from "better-sqlite3";

export type PersonalExchange = {
  userMessageId: number;
  userTs: number;
  sessionId: string;
  responseIds: number[];
  complete: boolean;
};

type MessageRow = {
  id: number;
  user_id: string;
  session_id: string;
  role: string;
  timestamp: number;
};

/** Eligible personal sessions share the sleep-consumed session filter. */
export function isEligiblePersonalSession(sessionId: string | null | undefined): boolean {
  const s = sessionId ?? "";
  if (s === "") return true;
  if (s.includes("_A_") || s.includes("_C_")) return true;
  let underscores = 0;
  for (const ch of s) if (ch === "_") underscores++;
  return underscores < 2;
}

/**
 * Group one principal's eligible messages into exchanges in timestamp/id
 * order. A user row opens an exchange; following assistant/compaction rows in
 * the same session join it until the next user row. A trailing user row with
 * no response, or a response with no preceding user, is unfinished and never
 * counts toward the completed budget.
 */
export function groupExchanges(
  rows: Array<{ id: number; session_id: string; role: string; timestamp: number }>,
): PersonalExchange[] {
  const exchanges: PersonalExchange[] = [];
  const openBySession = new Map<string, PersonalExchange>();
  for (const r of rows) {
    if (r.role === "user") {
      const open = { userMessageId: r.id, userTs: r.timestamp, sessionId: r.session_id, responseIds: [], complete: false };
      exchanges.push(open);
      openBySession.set(r.session_id, open);
    } else if (r.role === "assistant" || r.role === "compaction") {
      const open = openBySession.get(r.session_id);
      if (open) open.responseIds.push(r.id);
      // Responses without a preceding user turn in the same session are
      // retained but never form an exchange of their own.
    }
  }
  for (const e of exchanges) e.complete = e.responseIds.length > 0;
  return exchanges;
}

export function loadPrincipalMessages(
  db: Database.Database,
  principal: string,
): MessageRow[] {
  return db.prepare(
    "SELECT id, user_id, session_id, role, timestamp FROM messages WHERE user_id = ? ORDER BY timestamp ASC, id ASC",
  ).all(principal) as MessageRow[];
}

/** Completed exchanges for one principal across eligible sessions. */
export function completedExchanges(db: Database.Database, principal: string): PersonalExchange[] {
  const rows = loadPrincipalMessages(db, principal).filter((r) => isEligiblePersonalSession(r.session_id));
  return groupExchanges(rows).filter((e) => e.complete);
}

/** Count of completed exchanges (the ~1,000-exchange rolling target). */
export function countCompletedExchanges(db: Database.Database, principal: string): number {
  return completedExchanges(db, principal).length;
}

/** Distinct principals with personal message rows. */
export function listPersonalPrincipals(db: Database.Database): string[] {
  try {
    return (db.prepare("SELECT DISTINCT user_id FROM messages ORDER BY user_id").all() as Array<{ user_id: string }>).map(
      (r) => r.user_id,
    );
  } catch {
    return [];
  }
}
