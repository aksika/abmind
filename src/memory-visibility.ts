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
  principalUserId: string,
  ceiling: number,
): { sql: string; params: (string | number)[] } {
  const p = columnPrefix === "" ? "" : `${columnPrefix}.`;
  return {
    sql: `COALESCE(${p}classification, 0) <= ? AND (COALESCE(${p}classification, 0) <= 1 OR ${p}user_id = ?)`,
    params: [ceiling, principalUserId],
  };
}
