/**
 * Search daily/weekly/quarterly consolidation .md files directly from disk.
 * Replaces the former compactions table LIKE search (L3) — no sync needed.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logDebug, logTrace } from "./mem-logger.js";
import { parseDailyWrittenAt, parseLegacyDailyWriteTs } from "./sleep/sleep-daily-summary.js";

const TAG = "recall";

export type ConsolidationTier = "daily" | "weekly" | "quarterly";

export type ConsolidationResult = {
  tier: ConsolidationTier;
  timestamp: number;
  content: string;
  filePath: string;
};

const TIERS: ConsolidationTier[] = ["daily", "weekly", "quarterly"];

function parseTimestamp(tier: ConsolidationTier, filename: string): number {
  if (tier === "daily") {
    // #1821: the filename is the UTC write instant; covered-day names keep
    // working as the write instant of their covered day's midnight.
    const writtenAt = parseDailyWrittenAt(filename);
    if (writtenAt !== null) return writtenAt;
    const legacy = parseLegacyDailyWriteTs(filename);
    if (legacy !== null) return legacy;
  } else if (tier === "weekly") {
    const m = filename.match(/weekly_(\d{4})-W(\d{2})\.md/);
    if (m) {
      // ISO week → approximate Monday of that week
      const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
      const dow = jan4.getUTCDay() || 7;
      const week1Monday = new Date(jan4.getTime() - (dow - 1) * 86_400_000);
      return week1Monday.getTime() + (Number(m[2]) - 1) * 7 * 86_400_000;
    }
    // Writer-produced calendar-date names (sleep orchestrator output path and
    // the #640 housekeeping migration). Without this branch newly written
    // output is invisible to discovery.
    const d = filename.match(/weekly_(\d{4})-(\d{2})-(\d{2})\.md/);
    if (d) return new Date(`${d[1]}-${d[2]}-${d[3]}T00:00:00Z`).getTime();
  } else if (tier === "quarterly") {
    const m = filename.match(/quarterly_(\d{4})-Q(\d)\.md/);
    if (m) return new Date(Date.UTC(Number(m[1]), (Number(m[2]) - 1) * 3, 1)).getTime();
    const d = filename.match(/quarterly_(\d{4})-(\d{2})-(\d{2})\.md/);
    if (d) return new Date(`${d[1]}-${d[2]}-${d[3]}T00:00:00Z`).getTime();
  }
  return 0;
}

function loadFiles(memoryDir: string): ConsolidationResult[] {
  const results: ConsolidationResult[] = [];
  for (const tier of TIERS) {
    const dir = join(memoryDir, tier);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch (err) {
      logTrace(TAG, `S6: tier dir unreadable (${dir}): ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const filePath = join(dir, file);
      try {
        const content = readFileSync(filePath, "utf-8");
        const timestamp = parseTimestamp(tier, file);
        if (timestamp > 0) results.push({ tier, timestamp, content, filePath });
      } catch (err) {
        logTrace(TAG, `S6: skipping unreadable file (${filePath}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return results;
}

export function searchConsolidationFiles(
  memoryDir: string,
  keywords: string[],
  opts?: { startTime?: number; endTime?: number },
): ConsolidationResult[] {
  const files = loadFiles(memoryDir);
  const kws = keywords.map((k) => k.toLowerCase().trim()).filter(Boolean);
  if (kws.length === 0) return [];

  const matched = files
    .filter((f) => {
      if (opts?.startTime && f.timestamp < opts.startTime) return false;
      if (opts?.endTime && f.timestamp > opts.endTime) return false;
      const lower = f.content.toLowerCase();
      return kws.some((kw) => lower.includes(kw));
    })
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 10);
  logDebug(TAG, `S6: ${files.length} files scanned, ${matched.length} excerpts for ${kws.length} keywords`);
  return matched;
}

export function getLatestConsolidationFile(
  memoryDir: string,
  tier: ConsolidationTier = "daily",
): ConsolidationResult | null {
  const files = loadFiles(memoryDir).filter((f) => f.tier === tier);
  if (files.length === 0) return null;
  files.sort((a, b) => b.timestamp - a.timestamp);
  return files[0] ?? null;
}
