/** Deterministic owner-scoped beliefs and temporal revision reads. */
import type Database from "better-sqlite3";
import { isUserAuthoritative } from "./personal-durable.js";
import type { AuthorityClass } from "./personal-episodes.js";
import { isSuppressedByForget } from "./personal-forget.js";
import { requirePersonalRoute } from "./personal-readiness.js";

export type BeliefRow = {
  id: number; user_id: string; memory_type: string; content: string;
  authority: "user_statement" | "confirmed_decision" | "agent_proposal" | "inference";
  applicability_scope: string; valid_from: string | null; valid_to: string | null;
  revision: number; supersedes_id: number | null; superseded_by_id: number | null;
  created_at: number;
};
export type BeliefResolution =
  | { status: "resolved"; memory: BeliefRow; rationale: string }
  | { status: "unresolved"; claims: BeliefRow[]; rationale: string }
  | { status: "none"; rationale: string };

function parseScope(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid personal applicability scope");
  return value as Record<string, unknown>;
}
function constraints(scope: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(scope).filter(([key, value]) => !(key === "scope" && value === "general"));
}
export function scopeMatches(stored: Record<string, unknown>, request: Record<string, unknown>): boolean {
  return constraints(stored).every(([key, value]) => JSON.stringify(request[key]) === JSON.stringify(value));
}
export function validityContains(row: BeliefRow, atDate: string): boolean {
  return (!row.valid_from || atDate >= row.valid_from) && (!row.valid_to || atDate < row.valid_to);
}
function claimTopic(provenance: string): string | null {
  // Converted rows predate the provenance-topic convention and carry no
  // topic; direct stores and sleep promotions do. A missing topic is null,
  // never a fabricated label.
  try {
    const proven = JSON.parse(provenance) as Record<string, unknown>;
    return typeof proven["topic"] === "string" ? proven["topic"] : null;
  } catch {
    return null;
  }
}
function claimIdentity(row: BeliefRow & { provenance: string }): string {
  // Claim identity keeps unrelated knowledge from becoming one conflict set:
  // authority and scope-dominance apply only within the same claim (same
  // memory type and same provenance topic), never across claims.
  return `${row.memory_type}::${claimTopic(row.provenance) ?? ""}`;
}
function todayLocal(): string {
  const d = new Date();
  return String(d.getFullYear()) + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function dominates(a: BeliefRow, b: BeliefRow): boolean {
  const ac = constraints(parseScope(a.applicability_scope)), bc = constraints(parseScope(b.applicability_scope));
  return ac.length > bc.length && bc.every(([key, value]) => ac.some(([other, v]) => other === key && JSON.stringify(v) === JSON.stringify(value)));
}
function resolve(db: Database.Database, owner: string, scope: Record<string, unknown>, atDate: string, opts?: { topic?: string; memoryType?: string }): BeliefResolution {
  requirePersonalRoute(db, "recall");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(atDate) || !Number.isFinite(Date.parse(atDate))) throw new Error("invalid as-of date");
  const current = db.prepare("SELECT * FROM long_term_memories WHERE user_id = ? AND classification < 3").all(owner) as Array<BeliefRow & { provenance: string }>;
  const revisions = db.prepare("SELECT r.*, r.memory_id AS id, m.memory_type, m.superseded_by_id FROM long_term_revisions r JOIN long_term_memories m ON m.id = r.memory_id AND m.user_id = r.user_id WHERE r.user_id = ? AND r.classification < 3 AND m.classification < 3")
    .all(owner) as Array<BeliefRow & { provenance: string }>;
  const seen = new Set<string>();
  let eligible = [...current, ...revisions].filter(row => {
    const key = String(row.id) + ":" + String(row.revision);
    if (seen.has(key)) return false;
    seen.add(key);
    if (opts?.memoryType && row.memory_type !== opts.memoryType) return false;
    if (opts?.topic && (JSON.parse(row.provenance) as Record<string, unknown>)["topic"] !== opts.topic) return false;
    return validityContains(row, atDate) && scopeMatches(parseScope(row.applicability_scope), scope) &&
      !isSuppressedByForget(db, owner, { durableId: row.id });
  });
  if (!eligible.length) return { status: "none", rationale: "no applicable non-forgotten belief" };
  // Partition by claim identity first: unrelated knowledge never shares a
  // conflict set and never dominates across claims. Authority and dominance
  // resolve only within one claim.
  const partitions = new Map<string, typeof eligible>();
  for (const row of eligible) {
    const key = claimIdentity(row);
    const group = partitions.get(key);
    if (group) group.push(row);
    else partitions.set(key, [row]);
  }
  const winners: typeof eligible = [];
  for (const group of partitions.values()) {
    let contenders = group;
    const authoritative = contenders.filter(row => isUserAuthoritative(row.authority));
    if (authoritative.length) contenders = authoritative;
    contenders = contenders.filter(row => !contenders.some(other => dominates(other, row)));
    winners.push(...contenders);
  }
  if (partitions.size === 1 && winners.length === 1 && winners[0]) return { status: "resolved", memory: winners[0], rationale: "applicable evidence and scoped revision at the requested time" };
  return { status: "unresolved", claims: winners, rationale: "independent applicable claims coexist; timestamps alone do not resolve them" };
}
export function resolveCurrentBelief(db: Database.Database, owner: string, requestScope: Record<string, unknown>, opts?: { atDate?: string; topic?: string; memoryType?: string }): BeliefResolution {
  return resolve(db, owner, requestScope, opts?.atDate ?? todayLocal(), opts);
}
export function resolveBeliefAsOf(db: Database.Database, owner: string, requestScope: Record<string, unknown>, asOfDate: string): BeliefResolution {
  return resolve(db, owner, requestScope, asOfDate);
}

/**
 * Co-applicable same-claim siblings of one durable (#1930 M3 production
 * claim selection). The settlement path stores the new durable first —
 * coexistence is allowed — and calls this to decide whether the clash stays
 * visible: a non-empty result means the claims coexist unresolved until the
 * owner corrects one through the revision-safe boundary.
 *
 * Matching mirrors resolve(): same owner and memory type, both current and
 * valid today, overlapping applicability scope, same claim topic. A missing
 * topic on either side matches rather than hides: converted rows predate
 * the topic convention, and a possible clash must stay owner-visible. A new
 * subordinate inference never conflicts with applicable user-authoritative
 * knowledge — the hierarchy already decides that case, so no receipt.
 */
export function findClaimConflicts(db: Database.Database, owner: string, durableId: number): number[] {
  const self = db.prepare("SELECT * FROM long_term_memories WHERE id = ? AND user_id = ?").get(durableId, owner) as
    | (BeliefRow & { provenance: string; classification: number })
    | undefined;
  if (!self || self.superseded_by_id !== null || self.classification >= 3) return [];
  const today = todayLocal();
  if (!validityContains(self, today)) return [];
  let selfScope: Record<string, unknown>;
  try {
    selfScope = parseScope(self.applicability_scope);
  } catch {
    selfScope = { scope: "general" };
  }
  const selfTopic = claimTopic(self.provenance);
  const siblings = db.prepare(
    "SELECT * FROM long_term_memories WHERE user_id = ? AND memory_type = ? AND id != ? AND superseded_by_id IS NULL AND classification < 3",
  ).all(owner, self.memory_type, durableId) as Array<BeliefRow & { provenance: string; classification: number }>;
  const matched: number[] = [];
  for (const row of siblings) {
    if (isSuppressedByForget(db, owner, { durableId: row.id })) continue;
    if (!validityContains(row, today)) continue;
    const rowTopic = claimTopic(row.provenance);
    if (selfTopic !== null && rowTopic !== null && selfTopic !== rowTopic) continue;
    let rowScope: Record<string, unknown>;
    try {
      rowScope = parseScope(row.applicability_scope);
    } catch {
      continue;
    }
    if (!scopeMatches(rowScope, selfScope) && !scopeMatches(selfScope, rowScope)) continue;
    matched.push(row.id);
  }
  if (matched.length === 0) return [];
  if (!isUserAuthoritative(self.authority)) {
    const authoritative = db.prepare(
      "SELECT authority FROM long_term_memories WHERE user_id = ? AND id IN (" + matched.map(() => "?").join(",") + ")",
    ).all(owner, ...matched) as Array<{ authority: AuthorityClass }>;
    if (authoritative.some((row) => isUserAuthoritative(row.authority))) return [];
  }
  return matched;
}
