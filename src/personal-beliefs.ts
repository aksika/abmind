/**
 * personal-beliefs.ts — Deterministic current applicable belief over the
 * frozen precedence rule (C2, absorbed #1924).
 *
 * Current belief for a request scope resolves over authorized,
 * non-forgotten rows whose validity contains the request time and whose
 * applicability matches. User-authoritative evidence outranks agent-proposed
 * evidence; a matching explicit scoped exception applies ahead of the
 * general claim. Explicit correction/supersession links decide within an
 * overlapping scope/time. A later timestamp alone never resolves independent
 * conflicting user statements. Historical queries evaluate validity and
 * supersession as of the requested time.
 */

import type Database from "better-sqlite3";
import { isUserAuthoritative } from "./personal-durable.js";

export type BeliefRow = {
  id: number;
  user_id: string;
  memory_type: string;
  content: string;
  authority: "user_statement" | "confirmed_decision" | "agent_proposal" | "inference";
  applicability_scope: string;
  valid_from: string | null;
  valid_to: string | null;
  revision: number;
  supersedes_id: number | null;
  superseded_by_id: number | null;
  created_at: number;
};

export type BeliefResolution =
  | { status: "resolved"; memory: BeliefRow; rationale: string }
  | { status: "unresolved"; claims: BeliefRow[]; rationale: string }
  | { status: "none"; rationale: string };

function parseScope(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { scope: "general" };
  }
}

/** Scope match: exact scope equality, or a stored exception whose `scope`
 *  equals the request scope. Incomparable scopes never order arbitrarily. */
export function scopeMatches(stored: Record<string, unknown>, request: Record<string, unknown>): boolean {
  const sScope = stored["scope"];
  const rScope = request["scope"];
  if (sScope === rScope) return true;
  // A general claim does not implicitly cover a scoped request and vice
  // versa; only explicit equal scopes match.
  return false;
}

/** Validity contains the request date (YYYY-MM-DD). Null bounds are open. */
export function validityContains(row: BeliefRow, atDate: string): boolean {
  if (row.valid_from && atDate < row.valid_from) return false;
  if (row.valid_to && atDate >= row.valid_to) return false;
  return true;
}

function isForgotten(db: Database.Database, owner: string, durableId: number): boolean {
  try {
    const row = db.prepare(
      "SELECT 1 FROM forget_markers WHERE owner = ? AND record_kind = 'durable' AND record_id = ? LIMIT 1",
    ).get(owner, durableId) as unknown;
    return Boolean(row);
  } catch {
    return false;
  }
}

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Resolve the current applicable belief for one owner + request scope.
 * Reads eligible rows (classification < 3, non-forgotten) and applies the
 * frozen precedence without inventing a winner for independent conflicts.
 */
export function resolveCurrentBelief(
  db: Database.Database,
  owner: string,
  requestScope: Record<string, unknown>,
  opts?: { atDate?: string; topic?: string; memoryType?: string },
): BeliefResolution {
  const atDate = opts?.atDate ?? todayLocal();
  let rows: BeliefRow[];
  try {
    const clauses = ["user_id = ?", "classification < 3", "superseded_by_id IS NULL"];
    const params: unknown[] = [owner];
    if (opts?.memoryType) {
      clauses.push("memory_type = ?");
      params.push(opts.memoryType);
    }
    rows = db.prepare(`SELECT * FROM long_term_memories WHERE ${clauses.join(" AND ")}`).all(...params) as BeliefRow[];
  } catch {
    return { status: "none", rationale: "durable layer unavailable" };
  }
  const eligible = rows.filter(
    (r) => validityContains(r, atDate) && scopeMatches(parseScope(r.applicability_scope), requestScope),
  );
  const visible = eligible.filter((r) => !isForgotten(db, owner, r.id));
  if (visible.length === 0) return { status: "none", rationale: "no applicable non-forgotten belief" };

  // Explicit scoped exception ahead of the general claim: a row whose scope
  // exactly equals a non-general request scope wins over general rows.
  const requestScopeName = requestScope["scope"];
  if (requestScopeName !== undefined && requestScopeName !== "general") {
    const scoped = visible.filter((r) => {
      const s = parseScope(r.applicability_scope);
      return s["scope"] === requestScopeName;
    });
    if (scoped.length === 1) {
      return { status: "resolved", memory: scoped[0]!, rationale: "matching explicit scoped exception" };
    }
    if (scoped.length > 1) {
      // Multiple rows in the same explicit scope with no supersession link
      // remain unresolved even with different timestamps.
      const authoritative = scoped.filter((r) => isUserAuthoritative(r.authority));
      if (authoritative.length === 1 && scoped.every((r) => r.supersedes_id !== null || r.id === authoritative[0]!.id)) {
        return { status: "resolved", memory: authoritative[0]!, rationale: "single user-authoritative claim in scope" };
      }
      return { status: "unresolved", claims: scoped, rationale: "independent conflicting claims coexist" };
    }
  }

  // General scope: user-authoritative outranks agent-proposed, but two
  // independent user statements remain unresolved without an evidenced
  // correction/supersession link.
  const userRows = visible.filter((r) => isUserAuthoritative(r.authority));
  const linked = visible.filter((r) => r.supersedes_id !== null);
  if (visible.length === 1) {
    return { status: "resolved", memory: visible[0]!, rationale: "single applicable claim" };
  }
  if (userRows.length === 1 && visible.every((r) => isUserAuthoritative(r.authority) === false || r.id === userRows[0]!.id)) {
    // One user claim vs agent proposals: the user claim applies.
    if (linked.length === 0 || userRows[0]!.supersedes_id !== null) {
      return { status: "resolved", memory: userRows[0]!, rationale: "user-authoritative outranks agent-proposed" };
    }
  }
  return { status: "unresolved", claims: visible, rationale: "independent conflicting claims coexist" };
}

/**
 * Historical read as of a date: evaluates validity and supersession at that
 * time, including revisions superseded afterward. Uses the revisions table
 * plus current rows whose validity covered the date.
 */
export function resolveBeliefAsOf(
  db: Database.Database,
  owner: string,
  requestScope: Record<string, unknown>,
  asOfDate: string,
): BeliefResolution {
  let current: BeliefRow[];
  let revisions: Array<BeliefRow & { memory_id: number }> = [];
  try {
    current = db.prepare("SELECT * FROM long_term_memories WHERE user_id = ? AND classification < 3").all(owner) as BeliefRow[];
    revisions = db.prepare("SELECT *, memory_id FROM long_term_revisions WHERE user_id = ?").all(owner) as Array<
      BeliefRow & { memory_id: number }
    >;
  } catch {
    return { status: "none", rationale: "durable layer unavailable" };
  }
  const candidates: BeliefRow[] = [];
  for (const r of current) {
    // A row created after asOf cannot have applied then; rows whose
    // validity covered asOf are candidates even if since superseded.
    if (validityContains({ ...r, valid_to: r.valid_to ?? "9999-12-31" }, asOfDate)) {
      // Exclude rows whose valid_from postdates asOf (created later).
      if (r.valid_from && r.valid_from > asOfDate) continue;
      if (!scopeMatches(parseScope(r.applicability_scope), requestScope)) continue;
      if (isForgotten(db, owner, r.id)) continue;
      candidates.push(r);
    }
  }
  for (const rev of revisions) {
    const asRow: BeliefRow = {
      id: rev.memory_id,
      user_id: rev.user_id,
      memory_type: "fact",
      content: rev.content,
      authority: rev.authority as BeliefRow["authority"],
      applicability_scope: rev.applicability_scope,
      valid_from: rev.valid_from,
      valid_to: rev.valid_to ?? "9999-12-31",
      revision: rev.revision,
      supersedes_id: rev.supersedes_id,
      superseded_by_id: rev.memory_id,
      created_at: rev.created_at,
    };
    if (!validityContains(asRow, asOfDate)) continue;
    if (!scopeMatches(parseScope(asRow.applicability_scope), requestScope)) continue;
    // Avoid double-counting the same revision already represented.
    if (candidates.some((c) => c.id === asRow.id && c.revision === asRow.revision)) continue;
    candidates.push(asRow);
  }
  if (candidates.length === 0) return { status: "none", rationale: "no belief applied at that time" };
  if (candidates.length === 1) return { status: "resolved", memory: candidates[0]!, rationale: "then-applicable knowledge" };
  return { status: "unresolved", claims: candidates, rationale: "then-applicable claims coexisted" };
}
