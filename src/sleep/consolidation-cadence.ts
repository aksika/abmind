/**
 * consolidation-cadence.ts — consolidation cadence state and due decisions (#1864).
 *
 * Cadence needs no new ledger: the latest host-published, owner-verified
 * artifact with a parseable inclusive period is the checkpoint, and the next
 * period is due when its end is later than the checkpoint's end. Local
 * Monday–Sunday weeks are the weekly unit; completed calendar quarters are the
 * quarterly unit. Weekly and quarterly are independent; publishing one never
 * advances the other.
 *
 * Invariants that must stay true:
 * - The checkpoint is the artifact's declared period, never its filename or
 *   modification time; no trustworthy artifact, no advance.
 * - A missing date is unknown, not empty; selections report missing dates and
 *   never claim them as summarized.
 * - All comparisons use local date keys built by calendar construction; fixed
 *   millisecond day offsets are DST-unsafe and never used here.
 * - Every due range and lookback is bounded by MAX_WEEKLY_GAP_WEEKS, so
 *   unbounded downtime cannot grow the prompt or the per-run scan.
 * - Legacy/foreign/invalid artifacts are reported in counts, never deleted,
 *   relabeled, or treated as checkpoints.
 */

import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { localDate } from "../local-time.js";
import {
  consolidationFileName,
  parseArtifactOwner,
  parseConsolidationPeriod,
  parseConsolidationSources,
  type ConsolidationPeriod,
  type ConsolidationTierName,
} from "./sleep-daily-summary.js";
import {
  loadDailyCovers,
  selectDailiesForDates,
  type DailyCover,
} from "./step-prepare.js";

/** Maximum gap covered by one weekly publication, in completed weeks. */
export const MAX_WEEKLY_GAP_WEEKS = 8;

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse YYYY-MM-DD into calendar components, or null. */
export function parseDayKey(dayKey: string): { year: number; month: number; day: number } | null {
  const m = DAY_KEY_RE.exec(dayKey);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  if (day > new Date(year, month, 0).getDate()) return null;
  return { year, month, day };
}

/** Local-calendar day key, DST-safe. */
export function addDays(dayKey: string, days: number): string {
  const parts = parseDayKey(dayKey);
  if (parts === null) throw new Error(`addDays needs a YYYY-MM-DD day key, got "${dayKey}"`);
  return localDate(new Date(parts.year, parts.month - 1, parts.day + days));
}

/** Whole-day ordinal (UTC-based; date-key arithmetic only, no local offsets). */
export function dayOrdinal(dayKey: string): number {
  const parts = parseDayKey(dayKey);
  if (parts === null) throw new Error(`dayOrdinal needs a YYYY-MM-DD day key, got "${dayKey}"`);
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday, in the local calendar. */
export function weekdayOf(dayKey: string): number {
  const parts = parseDayKey(dayKey);
  if (parts === null) throw new Error(`weekdayOf needs a YYYY-MM-DD day key, got "${dayKey}"`);
  return new Date(parts.year, parts.month - 1, parts.day).getDay();
}

/** Inclusive local-date range enumeration. Callers bound the range. */
export function enumerateDays(start: string, end: string): string[] {
  const days: string[] = [];
  const endOrdinal = dayOrdinal(end);
  let cursor = start;
  while (dayOrdinal(cursor) <= endOrdinal) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

/** Most recent Sunday strictly before the run's local date. */
export function latestCompletedSunday(runDayKey: string): string {
  const offset = ((weekdayOf(runDayKey) + 6) % 7) + 1;
  return addDays(runDayKey, -offset);
}

export interface QuarterKey {
  readonly year: number;
  readonly quarter: number;
}

/** Calendar quarter containing a day key (1-based quarter). */
export function quarterOf(dayKey: string): QuarterKey {
  const parts = parseDayKey(dayKey);
  if (parts === null) throw new Error(`quarterOf needs a YYYY-MM-DD day key, got "${dayKey}"`);
  return { year: parts.year, quarter: Math.floor((parts.month - 1) / 3) + 1 };
}

/** First and last day of a calendar quarter. */
export function quarterBounds(year: number, quarter: number): ConsolidationPeriod {
  const startMonth = (quarter - 1) * 3 + 1;
  const start = `${year}-${String(startMonth).padStart(2, "0")}-01`;
  const end = localDate(new Date(year, startMonth + 2, 0));
  return { start, end };
}

/** `YYYY-Qn` label for an artifact name and human reports. */
export function quarterLabel(key: QuarterKey): string {
  return `${key.year}-Q${key.quarter}`;
}

function previousQuarter(key: QuarterKey): QuarterKey {
  return key.quarter === 1
    ? { year: key.year - 1, quarter: 4 }
    : { year: key.year, quarter: key.quarter - 1 };
}

function quarterOrdinal(key: QuarterKey): number {
  return key.year * 4 + (key.quarter - 1);
}

/** A weekly artifact is trustworthy when its declared period is a Monday-start,
 *  Sunday-end span of a whole number of weeks. Multi-week (gap) ranges are the
 *  reason this is not "exactly seven days". */
export function isValidWeeklyPeriod(period: ConsolidationPeriod): boolean {
  if (dayOrdinal(period.end) < dayOrdinal(period.start)) return false;
  if (weekdayOf(period.start) !== 1 || weekdayOf(period.end) !== 0) return false;
  return (dayOrdinal(period.end) - dayOrdinal(period.start) + 1) % 7 === 0;
}

/** A quarterly artifact is trustworthy when its declared period is exactly a
 *  calendar quarter; its filename key must agree. */
export function isValidQuarterlyPeriod(period: ConsolidationPeriod): boolean {
  const key = quarterOf(period.start);
  const bounds = quarterBounds(key.year, key.quarter);
  return period.start === bounds.start && period.end === bounds.end;
}

export interface CadenceCheckpoint {
  readonly path: string;
  readonly period: ConsolidationPeriod;
  readonly sources: readonly string[];
}

interface ArtifactScan {
  readonly trusted: CadenceCheckpoint[];
  readonly invalidCount: number;
  readonly foreignCount: number;
}

/**
 * Read one consolidation tier directory. A checkpoint candidate must carry the
 * owner line, both position-anchored period lines, and a tier-valid period;
 * everything else is counted as invalid or foreign and ignored.
 */
function scanTierArtifacts(
  dir: string,
  tier: ConsolidationTierName,
  owner?: string,
  validatePeriod?: (period: ConsolidationPeriod) => boolean,
): ArtifactScan {
  const trusted: CadenceCheckpoint[] = [];
  let invalidCount = 0;
  let foreignCount = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { trusted, invalidCount, foreignCount }; // absent tier dir → nothing published yet
  }
  for (const file of entries.sort()) {
    if (!file.endsWith(".md")) continue;
    const path = join(dir, file);
    let content: string;
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      invalidCount++;
      continue;
    }
    const ownerLine = parseArtifactOwner(content);
    const period = parseConsolidationPeriod(content);
    if (ownerLine === null || period === null) {
      invalidCount++;
      continue;
    }
    if (owner !== undefined && ownerLine !== owner) {
      foreignCount++;
      continue;
    }
    if (validatePeriod !== undefined && !validatePeriod(period)) {
      invalidCount++;
      continue;
    }
    trusted.push({ path, period, sources: parseConsolidationSources(content) });
  }
  return { trusted, invalidCount, foreignCount };
}

function latestByEnd(items: readonly CadenceCheckpoint[]): CadenceCheckpoint | null {
  let latest: CadenceCheckpoint | null = null;
  for (const item of items) {
    if (
      latest === null
      || dayOrdinal(item.period.end) > dayOrdinal(latest.period.end)
      || (dayOrdinal(item.period.end) === dayOrdinal(latest.period.end) && item.path > latest.path)
    ) {
      latest = item;
    }
  }
  return latest;
}

export interface WeeklyDue {
  readonly due: boolean;
  /** Due range; equal to the checkpoint range when nothing is due. */
  readonly period: ConsolidationPeriod;
  readonly checkpoint: CadenceCheckpoint | null;
  /** No trustworthy checkpoint: first summary covers only the latest week. */
  readonly cutover: boolean;
  /** The remaining gap exceeded the cap; this publication is the oldest slice. */
  readonly capped: boolean;
}

export function decideWeeklyDue(trusted: readonly CadenceCheckpoint[], runDayKey: string): WeeklyDue {
  const endpoint = latestCompletedSunday(runDayKey);
  const latest = latestByEnd(trusted);
  if (latest === null) {
    const period = { start: addDays(endpoint, -6), end: endpoint };
    return { due: true, period, checkpoint: null, cutover: true, capped: false };
  }
  if (dayOrdinal(latest.period.end) >= dayOrdinal(endpoint)) {
    return { due: false, period: latest.period, checkpoint: latest, cutover: false, capped: false };
  }
  const start = addDays(latest.period.end, 1);
  const totalDays = dayOrdinal(endpoint) - dayOrdinal(start) + 1;
  const capped = totalDays > MAX_WEEKLY_GAP_WEEKS * 7;
  const end = capped ? addDays(start, MAX_WEEKLY_GAP_WEEKS * 7 - 1) : endpoint;
  return { due: true, period: { start, end }, checkpoint: latest, cutover: false, capped };
}

export interface QuarterlyDue {
  readonly due: boolean;
  /** Due quarter; equal to the checkpoint quarter when nothing is due. */
  readonly key: QuarterKey;
  readonly period: ConsolidationPeriod;
  readonly checkpoint: CadenceCheckpoint | null;
}

export function decideQuarterlyDue(trusted: readonly CadenceCheckpoint[], runDayKey: string): QuarterlyDue {
  const completed = previousQuarter(quarterOf(runDayKey));
  const latest = latestByEnd(trusted);
  if (latest === null) {
    return { due: true, key: completed, period: quarterBounds(completed.year, completed.quarter), checkpoint: null };
  }
  const latestKey = quarterOf(latest.period.start);
  if (quarterOrdinal(latestKey) >= quarterOrdinal(completed)) {
    return { due: false, key: latestKey, period: latest.period, checkpoint: latest };
  }
  // Oldest completed quarter after the latest valid checkpoint: a missed
  // quarter is published before a newer one, and retries keep their own range.
  const next = quarterOrdinal(latestKey) + 1;
  const key = { year: Math.floor(next / 4), quarter: (next % 4) + 1 };
  return { due: true, key, period: quarterBounds(key.year, key.quarter), checkpoint: latest };
}

export interface ConsolidationTarget {
  readonly tier: ConsolidationTierName;
  readonly period: ConsolidationPeriod;
  readonly outputPath: string;
  readonly coveredRange: string;
  readonly listSection: string;
  readonly missingDates: string[];
  readonly sourcePaths: string[];
}

export interface ConsolidationReport {
  readonly level: "warn" | "info";
  readonly message: string;
}

export interface ConsolidationPlan {
  readonly target: ConsolidationTarget | null;
  readonly skipReason: string;
  readonly reports: ConsolidationReport[];
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    ordered.push(path);
  }
  return ordered;
}

function coversDate(cover: DailyCover, date: string): boolean {
  return date >= cover.startDay && date <= cover.endDay;
}

function coverOverlapsPeriod(cover: DailyCover, period: ConsolidationPeriod): boolean {
  return cover.endDay >= period.start && cover.startDay <= period.end;
}

/**
 * Late sources (#1864): owner-verified dailies inside an already-summarized
 * weekly period whose path appears in no trustworthy weekly's Sources. The
 * membership test is the whole one-shot state; the lookback window bounds how
 * many weekly headers a run reads and what can still be backfilled. Dailies
 * inside periods only outside the window are reported, never backfilled.
 */
function detectLateDailies(
  covers: readonly DailyCover[],
  trustedWeeklies: readonly CadenceCheckpoint[],
  alreadySelected: ReadonlySet<string>,
  owner: string | undefined,
  lookbackStart: string,
  reports: ConsolidationReport[],
): DailyCover[] {
  if (trustedWeeklies.length === 0) return [];
  const summarizedSources = new Set<string>();
  for (const weekly of trustedWeeklies) {
    for (const source of weekly.sources) summarizedSources.add(source);
  }
  const late: DailyCover[] = [];
  let tooOld = 0;
  for (const cover of covers) {
    if (owner !== undefined && cover.owner !== owner) continue;
    if (alreadySelected.has(cover.path) || summarizedSources.has(cover.path)) continue;
    const overlapping = trustedWeeklies.filter((weekly) => coverOverlapsPeriod(cover, weekly.period));
    if (overlapping.length === 0) continue;
    const inWindow = overlapping.some((weekly) => dayOrdinal(weekly.period.end) >= dayOrdinal(lookbackStart));
    if (!inWindow) {
      tooOld++;
      continue;
    }
    late.push(cover);
  }
  late.sort((a, b) => a.startDay.localeCompare(b.startDay) || a.path.localeCompare(b.path));
  if (tooOld > 0) {
    reports.push({
      level: "warn",
      message: `${tooOld} owner-verified daily artifact(s) older than the ${MAX_WEEKLY_GAP_WEEKS}-week weekly lookback were reported, not backfilled`,
    });
  }
  return late;
}

function weeklyCoveredRange(due: WeeklyDue): string {
  if (due.cutover) {
    return `${due.period.start} to ${due.period.end} (first summary after cutover: no trustworthy prior weekly existed; earlier history was not backfilled)`;
  }
  const weeks = (dayOrdinal(due.period.end) - dayOrdinal(due.period.start) + 1) / 7;
  const shape = weeks === 1
    ? "completed Monday–Sunday week"
    : `${weeks} completed Monday–Sunday weeks`;
  const cappedNote = due.capped
    ? `; oldest ${MAX_WEEKLY_GAP_WEEKS} weeks of a longer gap`
    : "";
  return `${due.period.start} to ${due.period.end} (${shape}, inclusive${cappedNote})`;
}

function buildWeeklyTarget(
  memoryDir: string,
  runDayKey: string,
  due: WeeklyDue,
  trustedWeeklies: readonly CadenceCheckpoint[],
  owner: string | undefined,
  reports: ConsolidationReport[],
): ConsolidationTarget | null {
  const covers = loadDailyCovers(join(memoryDir, "daily"));
  const dates = enumerateDays(due.period.start, due.period.end);
  const selection = selectDailiesForDates(covers, dates, owner);
  if (selection.excluded.length > 0) {
    reports.push({
      level: "warn",
      message: `${selection.excluded.length} daily artifact(s) with unattributed or mismatched provenance were excluded from the due range`,
    });
  }
  const alreadySelected = new Set(selection.selected.map((s) => s.path));
  const lookbackStart = addDays(latestCompletedSunday(runDayKey), -(MAX_WEEKLY_GAP_WEEKS * 7 - 1));
  const late = detectLateDailies(covers, trustedWeeklies, alreadySelected, owner, lookbackStart, reports);
  if (selection.selected.length === 0 && late.length === 0) return null;

  const entries = selection.selected.map((s) => `- ${s.date}: ${s.path}`);
  for (const cover of late) {
    const summary = trustedWeeklies.find((weekly) => coverOverlapsPeriod(cover, weekly.period));
    const label = cover.startDay === cover.endDay ? cover.startDay : `${cover.startDay}..${cover.endDay}`;
    const periodLabel = summary === undefined ? "an earlier summarized period" : `${summary.period.start}..${summary.period.end}`;
    entries.push(`- ${label}: ${cover.path} (late source for the already-summarized ${periodLabel}; include once with its original date)`);
  }
  return {
    tier: "weekly",
    period: due.period,
    outputPath: join(memoryDir, "weekly", consolidationFileName("weekly", due.period)),
    coveredRange: weeklyCoveredRange(due),
    listSection: `Consolidation inputs (absolute paths — read exactly these, no discovery):\n${entries.join("\n")}`,
    missingDates: selection.missingDates,
    sourcePaths: uniquePaths([...selection.selected.map((s) => s.path), ...late.map((c) => c.path)]),
  };
}

/**
 * Quarterly inputs: trustworthy weeklies whose periods fall inside the quarter,
 * plus dailies only for dates no selected weekly represents — the union of each
 * weekly's declared period and the covers of its listed sources. Legacy
 * writer-date weeklies have no period lines, so they are never promoted and
 * their overlapping windows cannot duplicate content.
 */
function buildQuarterlyTarget(
  memoryDir: string,
  due: QuarterlyDue,
  trustedWeeklies: readonly CadenceCheckpoint[],
  owner: string | undefined,
  reports: ConsolidationReport[],
): ConsolidationTarget | null {
  const covers = loadDailyCovers(join(memoryDir, "daily"));
  const dates = enumerateDays(due.period.start, due.period.end);
  const inQuarter = trustedWeeklies.filter(
    (weekly) => weekly.period.start >= due.period.start && weekly.period.end <= due.period.end,
  );
  const coversByPath = new Map(covers.map((cover) => [cover.path, cover]));
  const represented = new Set<string>();
  for (const weekly of inQuarter) {
    for (const date of enumerateDays(weekly.period.start, weekly.period.end)) represented.add(date);
    for (const source of weekly.sources) {
      const cover = coversByPath.get(source);
      // A superseded source's window is already declared by the period.
      if (!cover) continue;
      for (const date of enumerateDays(cover.startDay, cover.endDay)) represented.add(date);
    }
  }
  const unresolved = dates.filter((date) => !represented.has(date));
  const selection = selectDailiesForDates(covers, unresolved, owner);
  if (selection.excluded.length > 0) {
    reports.push({
      level: "warn",
      message: `${selection.excluded.length} daily artifact(s) with unattributed or mismatched provenance were excluded from the due quarter`,
    });
  }
  if (inQuarter.length === 0 && selection.selected.length === 0) return null;

  const entries = inQuarter.map((weekly) => `- ${weekly.period.start}..${weekly.period.end}: ${weekly.path} (weekly summary)`);
  entries.push(...selection.selected.map((s) => `- ${s.date}: ${s.path}`));
  return {
    tier: "quarterly",
    period: due.period,
    outputPath: join(memoryDir, "quarterly", consolidationFileName("quarterly", due.period)),
    coveredRange: `${due.period.start} to ${due.period.end} (${quarterLabel(due.key)}, completed calendar quarter)`,
    listSection: `Consolidation inputs (absolute paths — read exactly these, no discovery):\n${entries.join("\n")}`,
    missingDates: selection.missingDates,
    sourcePaths: uniquePaths([...inQuarter.map((w) => w.path), ...selection.selected.map((s) => s.path)]),
  };
}

/**
 * Decide the run's consolidation target from published-artifact checkpoints.
 *
 * Precedence: weekly work first. A due weekly with no owner-verified sources
 * is a no-work skip that does not block a due quarterly in the same run; a
 * due quarterly stays due for a later run whenever weekly work publishes.
 */
export function planConsolidation(memoryDir: string, runDayKey: string, owner?: string): ConsolidationPlan {
  const reports: ConsolidationReport[] = [];
  const weeklyScan = scanTierArtifacts(join(memoryDir, "weekly"), "weekly", owner, isValidWeeklyPeriod);
  const quarterlyScan = scanTierArtifacts(join(memoryDir, "quarterly"), "quarterly", owner, isValidQuarterlyPeriod);
  if (weeklyScan.invalidCount + weeklyScan.foreignCount > 0) {
    reports.push({
      level: "warn",
      message: `weekly/: ${weeklyScan.invalidCount} legacy/invalid and ${weeklyScan.foreignCount} foreign-owner artifact(s) ignored for cadence`,
    });
  }
  if (quarterlyScan.invalidCount + quarterlyScan.foreignCount > 0) {
    reports.push({
      level: "warn",
      message: `quarterly/: ${quarterlyScan.invalidCount} legacy/invalid and ${quarterlyScan.foreignCount} foreign-owner artifact(s) ignored for cadence`,
    });
  }

  const weeklyDue = decideWeeklyDue(weeklyScan.trusted, runDayKey);
  const quarterlyDue = decideQuarterlyDue(quarterlyScan.trusted, runDayKey);
  if (weeklyDue.due && weeklyDue.cutover) {
    reports.push({
      level: "warn",
      message: `cutover: no trustworthy weekly exists; the first summary covers only ${weeklyDue.period.start} to ${weeklyDue.period.end} and earlier history is not backfilled`,
    });
  }
  if (weeklyDue.due && weeklyDue.capped) {
    reports.push({
      level: "warn",
      message: `weekly gap exceeds ${MAX_WEEKLY_GAP_WEEKS} completed weeks; publishing the oldest ${MAX_WEEKLY_GAP_WEEKS}-week range first (${weeklyDue.period.start} to ${weeklyDue.period.end})`,
    });
  }

  if (weeklyDue.due) {
    const target = buildWeeklyTarget(memoryDir, runDayKey, weeklyDue, weeklyScan.trusted, owner, reports);
    if (target !== null) {
      if (quarterlyDue.due) {
        reports.push({
          level: "warn",
          message: `quarterly ${quarterLabel(quarterlyDue.key)} remains due; weekly work has precedence this run and the quarter stays due until a complete quarterly exists`,
        });
      }
      return { target, skipReason: "", reports };
    }
    reports.push({
      level: "info",
      message: `due week ${weeklyDue.period.start} to ${weeklyDue.period.end} has no owner-verified inputs; quarterly due is evaluated independently`,
    });
  }

  if (quarterlyDue.due) {
    const target = buildQuarterlyTarget(memoryDir, quarterlyDue, weeklyScan.trusted, owner, reports);
    if (target !== null) return { target, skipReason: "", reports };
    reports.push({
      level: "warn",
      message: `quarterly ${quarterLabel(quarterlyDue.key)} is due but has no owner-verified inputs; it remains due`,
    });
    return { target: null, skipReason: `no owner-verified inputs for the due quarter ${quarterLabel(quarterlyDue.key)}`, reports };
  }

  if (weeklyDue.due) {
    return { target: null, skipReason: `no owner-verified dailies for the due week ${weeklyDue.period.start} to ${weeklyDue.period.end}`, reports };
  }
  return { target: null, skipReason: "no consolidation period is due", reports };
}
