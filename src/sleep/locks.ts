/**
 * sleep/locks.ts — date helpers + previous-lock scanning.
 *
 * Extracted from orchestrator.ts (#1229 / #208 Stage 2). Pure data helpers
 * (date formatting/parsing) plus scanPreviousLocks, which reads persisted sleep
 * lock files via state.ts. Depends only on state.ts — no edge into orchestrator.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readStateFile } from "./state.js";
import type { SleepState } from "./state.js";

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

export interface PreviousLock {
  path: string;
  dateStr: string; // YYYYMMDD
  state: SleepState;
  ageDays: number;
}

export function scanPreviousLocks(sleepDir: string, todayStr: string): PreviousLock[] {
  if (!existsSync(sleepDir)) return [];
  const locks: PreviousLock[] = [];
  const todayMs = dateStrToMs(todayStr);
  for (const f of readdirSync(sleepDir)) {
    const m = f.match(/^sleep_(\d{8})\.lock$/);
    if (!m || m[1] === todayStr) continue;
    const state = readStateFile(join(sleepDir, f));
    if (!state) continue;
    const ageDays = Math.round((todayMs - dateStrToMs(m[1]!)) / 86400000);
    if (ageDays > 0) locks.push({ path: join(sleepDir, f), dateStr: m[1]!, state, ageDays });
  }
  return locks.sort((a, b) => b.dateStr.localeCompare(a.dateStr)); // newest first
}

export function dateStrToMs(ds: string): number {
  return new Date(`${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}T00:00:00`).getTime();
}

export function dateStrToFormatted(ds: string): string {
  return `${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}`;
}
