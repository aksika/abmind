/**
 * memory-visibility.ts — the single shared-or-owned extracted-memory policy
 * for the general recall pipeline (Sf, Se, Ss, FTS, timelines, graph).
 *
 * SQL fragment produced by sharedOrOwnedClause():
 *   COALESCE(<alias>.classification, 0) <= :ceiling
 *   AND (COALESCE(<alias>.classification, 0) <= 1 OR <alias>.user_id = :principal)
 */

/**
 * Highest classification the general recall pipeline may return.
 *
 * Default-deny is permanent policy, not a stopgap: no ordinary recall caller
 * (sleep prompts, wake-up, flashback, timeline, entity graph, hooks, compaction)
 * can surface a class-3 row. #1660 adds a narrow, explicitly requested sealed-
 * secret path that opts past this ceiling and returns labels only — it does not
 * remove the ceiling.
 */
export const RECALL_MAX_CLASSIFICATION = 2;

/**
 * The only place that computes the classification ceiling. No call site may
 * roll its own `Math.min(maxClassification, 2)`; #1660's opt-in path must go
 * through this helper with an explicit parameter rather than hand-rolled SQL.
 */
export function effectiveMaxClassification(requested?: number): number {
  return Math.min(requested ?? RECALL_MAX_CLASSIFICATION, RECALL_MAX_CLASSIFICATION);
}

/**
 * Shared-or-owned visibility clause with bound parameters.
 *
 * `columnPrefix` is the table alias ("em") or "" for a bare FROM.
 * Always requires a principal: missing identity cannot leak shared rows.
 */
export function sharedOrOwnedClause(
  columnPrefix: string,
  principalUserId: string | number,
  ceiling: number,
): { sql: string; params: (string | number)[] } {
  const principal = typeof principalUserId === "string"
    ? principalUserId
    : typeof principalUserId === "number" && Number.isFinite(principalUserId)
      ? principalUserId
      : null;
  if (principal === null || (typeof principal === "string" && principal.trim() === "")) {
    return { sql: "0", params: [] };
  }
  const p = columnPrefix === "" ? "" : `${columnPrefix}.`;
  return {
    sql: `COALESCE(${p}classification, 0) <= ? AND (COALESCE(${p}classification, 0) <= 1 OR ${p}user_id = ?)`,
    params: [ceiling, principal],
  };
}

/**
 * The distinct sealed-search policy (#1660): exact owner equality plus the
 * version-1 sealed-row predicate. This is a separate method and policy from
 * general recall — Master status does not grant access to another principal's
 * labels or values. Callers use `findSealedSecrets`; nothing else may paste
 * this predicate into general recall stages.
 */
export function sealedSearchVisibility(userId: string): { sql: string; params: (string | number)[] } {
  return {
    sql: "classification >= 3 AND sealed_format_version = 1 AND encrypted = 1 AND user_id = ? AND valid_to IS NULL",
    params: [userId],
  };
}
