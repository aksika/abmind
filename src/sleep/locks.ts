/**
 * sleep/locks.ts — Lock-file date-string helpers.
 * Extracted from orchestrator.ts (#1229). #1905 removed the stale-lock
 * recovery scan: locks are run receipts only, never a dispatch trigger.
 */

/** Format a timestamp as YYYYMMDD (for lock file names). */
export function toDateStr(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** Format a timestamp as YYYY-MM-DD (for daily file paths). */
export function toIsoDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dateStrToFormatted(ds: string): string {
  return `${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}`;
}
