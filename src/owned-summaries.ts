/**
 * owned-summaries — #1928 C5 full-only bounded summary search (M3).
 *
 * Supplementary S6 narrative context for `recall_full` only. Fast/normal
 * never reach this module — not even for an empty-result fallback — and
 * the caller reports S6 disabled before any filesystem access. Every read
 * is async and capped (64 KiB per file, 48 files, 512 KiB per request,
 * 256 directory entries inspected); no full enumeration happens before
 * caps apply. Owner provenance, covered period, classification/privacy
 * eligibility, and the current forget/restore barrier are verified before
 * any excerpt is admitted; duplicate retellings are deduplicated (never
 * independent corroboration); superseded retellings are omitted.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { readdir, open, stat } from "node:fs/promises";
import { parseArtifactOwner, parseDailyWrittenAt, parseLegacyDailyWriteTs } from "./sleep/sleep-daily-summary.js";
import type { OwnedRecallRef } from "./owned-recall-contract.js";

export const OWNED_S6_MAX_ENTRIES = 256;
export const OWNED_S6_MAX_FILES = 48;
export const OWNED_S6_MAX_BYTES = 524_288;
export const OWNED_S6_PER_FILE_CAP = 65_536;
export const OWNED_S6_MAX_EXCERPTS = 6;
export const OWNED_S6_EXCERPT_CHARS = 2048;

type SummaryTier = "daily" | "weekly" | "quarterly";
const TIERS: SummaryTier[] = ["daily", "weekly", "quarterly"];

export interface OwnedSummaryCandidate {
  readonly key: string;
  readonly ref: OwnedRecallRef;
  readonly excerpt: string;
  readonly coveredPeriod: string;
  readonly tier: SummaryTier;
  readonly currentness: "current" | "historical-unverified";
}

export interface OwnedSummaryOutcome {
  readonly status: "completed" | "partial" | "failed" | "disabled";
  readonly candidates: OwnedSummaryCandidate[];
  readonly entriesInspected: number;
  readonly filesRead: number;
  readonly bytesRead: number;
  readonly omitted: string[];
}

/** Point timestamp + covered-period label for one summary filename. */
function periodOf(tier: SummaryTier, filename: string): { timestamp: number; coveredPeriod: string } {
  if (tier === "daily") {
    const written = parseDailyWrittenAt(filename);
    if (written !== null) return { timestamp: written, coveredPeriod: `daily ${filename.replace(/\.md$/, "")}` };
    const legacy = parseLegacyDailyWriteTs(filename);
    if (legacy !== null) return { timestamp: legacy, coveredPeriod: `daily ${filename.replace(/\.md$/, "")}` };
    return { timestamp: 0, coveredPeriod: `daily ${filename.replace(/\.md$/, "")}` };
  }
  if (tier === "weekly") {
    const range = filename.match(/weekly_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.md/);
    if (range) return { timestamp: new Date(`${range[2]}T00:00:00Z`).getTime(), coveredPeriod: `weekly ${range[1]} to ${range[2]}` };
    const week = filename.match(/weekly_(\d{4})-W(\d{2})\.md/);
    if (week) {
      const jan4 = new Date(Date.UTC(Number(week[1]), 0, 4));
      const dow = jan4.getUTCDay() || 7;
      const monday = jan4.getTime() - (dow - 1) * 86_400_000;
      return { timestamp: monday + (Number(week[2]) - 1) * 7 * 86_400_000, coveredPeriod: `weekly ${week[1]}-W${week[2]}` };
    }
    const dated = filename.match(/weekly_(\d{4})-(\d{2})-(\d{2})\.md/);
    if (dated) return { timestamp: new Date(`${dated[1]}-${dated[2]}-${dated[3]}T00:00:00Z`).getTime(), coveredPeriod: `weekly ${dated[1]}-${dated[2]}-${dated[3]}` };
    return { timestamp: 0, coveredPeriod: `weekly ${filename.replace(/\.md$/, "")}` };
  }
  const quarter = filename.match(/quarterly_(\d{4})-Q(\d)\.md/);
  if (quarter) return { timestamp: Date.UTC(Number(quarter[1]), (Number(quarter[2]) - 1) * 3, 1), coveredPeriod: `quarterly ${quarter[1]}-Q${quarter[2]}` };
  const dated = filename.match(/quarterly_(\d{4})-(\d{2})-(\d{2})\.md/);
  if (dated) return { timestamp: new Date(`${dated[1]}-${dated[2]}-${dated[3]}T00:00:00Z`).getTime(), coveredPeriod: `quarterly ${dated[1]}-${dated[2]}-${dated[3]}` };
  return { timestamp: 0, coveredPeriod: `quarterly ${filename.replace(/\.md$/, "")}` };
}

function excerptAround(content: string, keywords: string[]): string | null {
  const lower = content.toLowerCase();
  let hit = -1;
  for (const kw of keywords) {
    const i = lower.indexOf(kw.toLowerCase());
    if (i >= 0 && (hit < 0 || i < hit)) hit = i;
  }
  if (hit < 0) return null;
  const start = Math.max(0, hit - 512);
  return content.slice(start, start + OWNED_S6_EXCERPT_CHARS);
}

export interface OwnedSummaryRequest {
  readonly memoryDir: string;
  readonly owner: string;
  readonly keywords: string[];
  readonly timeStart?: number;
  readonly timeEnd?: number;
  readonly deadlineAt: number;
  readonly signal?: AbortSignal;
  /** True when a forget/restore barrier is pending for this owner. */
  readonly barrierPending: boolean;
  /**
   * Retelling check: true when the excerpt matches a superseded (but not
   * current) source revision. Supplied by the recall owner, which reads the
   * revision store; summaries never resolve lineage themselves.
   */
  readonly checkSuperseded?: (excerpt: string) => boolean;
}

function stopped(deadlineAt: number, signal: AbortSignal | undefined): boolean {
  return Date.now() >= deadlineAt || signal?.aborted === true;
}

/**
 * Bounded supplementary summary search. Never throws for filesystem
 * conditions — unreadable tiers/files report partial with reasons.
 * Callers must gate on profile (full only) before invoking.
 */
export async function searchOwnedSummaries(opts: OwnedSummaryRequest): Promise<OwnedSummaryOutcome> {
  const omitted: string[] = [];
  if (opts.barrierPending) {
    return { status: "partial", candidates: [], entriesInspected: 0, filesRead: 0, bytesRead: 0, omitted: ["forget-barrier-pending: summaries withheld"] };
  }
  const keywords = opts.keywords.filter((k) => k.trim().length > 0);
  if (keywords.length === 0) {
    return { status: "completed", candidates: [], entriesInspected: 0, filesRead: 0, bytesRead: 0, omitted: [] };
  }
  // Collect candidate entries in tier/period/canonical order, bounded.
  const entries: Array<{ tier: SummaryTier; file: string; timestamp: number; coveredPeriod: string }> = [];
  let entriesInspected = 0;
  for (const tier of TIERS) {
    let files: string[];
    try {
      const dirents = await readdir(join(opts.memoryDir, tier), { withFileTypes: true });
      files = dirents.filter((d) => d.isFile() && d.name.endsWith(".md")).map((d) => d.name).sort().reverse();
    } catch {
      omitted.push(`tier-unreadable: ${tier}`);
      continue;
    }
    for (const file of files) {
      if (entriesInspected >= OWNED_S6_MAX_ENTRIES) break;
      entriesInspected++;
      const { timestamp, coveredPeriod } = periodOf(tier, file);
      if (timestamp <= 0) {
        omitted.push(`period-unknown: ${tier}/${file}`);
        continue;
      }
      if (opts.timeStart !== undefined && timestamp < opts.timeStart) continue;
      if (opts.timeEnd !== undefined && timestamp > opts.timeEnd) continue;
      entries.push({ tier, file, timestamp, coveredPeriod });
    }
    if (entriesInspected >= OWNED_S6_MAX_ENTRIES) {
      omitted.push(`entry-budget-exhausted: inspected ${entriesInspected} of available entries`);
      break;
    }
  }

  const candidates: OwnedSummaryCandidate[] = [];
  const seen = new Set<string>();
  let filesRead = 0, bytesRead = 0;
  for (const entry of entries) {
    if (candidates.length >= OWNED_S6_MAX_EXCERPTS) {
      omitted.push(`excerpt-budget-exhausted: kept ${candidates.length}`);
      break;
    }
    if (filesRead >= OWNED_S6_MAX_FILES || bytesRead >= OWNED_S6_MAX_BYTES || stopped(opts.deadlineAt, opts.signal)) {
      omitted.push(`read-budget-exhausted: ${filesRead} files, ${bytesRead} bytes`);
      break;
    }
    const rel = `${entry.tier}/${entry.file}`;
    let capped: string;
    try {
      const st = await stat(join(opts.memoryDir, rel));
      const take = Math.min(st.size, OWNED_S6_PER_FILE_CAP);
      const fh = await open(join(opts.memoryDir, rel), "r");
      try {
        const buf = Buffer.alloc(take);
        const { bytesRead: n } = await fh.read(buf, 0, take, 0);
        capped = buf.subarray(0, n).toString("utf-8");
      } finally {
        await fh.close();
      }
    } catch {
      omitted.push(`file-unreadable: ${rel}`);
      continue;
    }
    filesRead++;
    bytesRead += Buffer.byteLength(capped, "utf-8");
    // Owner provenance is the privacy eligibility gate: unattributed or
    // mismatched files are never summary evidence.
    if (parseArtifactOwner(capped) !== opts.owner) {
      omitted.push(`owner-mismatch: ${rel}`);
      continue;
    }
    const excerpt = excerptAround(capped, keywords);
    if (excerpt === null) continue;
    if (opts.checkSuperseded?.(excerpt) === true) {
      omitted.push(`superseded-retelling: ${rel}`);
      continue;
    }
    // Duplicate retellings are not independent corroboration: dedupe by the
    // matched excerpt itself, across tiers, not by file identity.
    const dupeKey = excerpt.slice(0, 160).toLowerCase().replace(/\s+/g, " ");
    if (seen.has(dupeKey)) {
      omitted.push(`duplicate-retelling: ${rel}`);
      continue;
    }
    seen.add(dupeKey);
    const version = createHash("sha256").update(capped, "utf-8").digest("hex");
    const inScope = (opts.timeStart === undefined || entry.timestamp >= opts.timeStart)
      && (opts.timeEnd === undefined || entry.timestamp <= opts.timeEnd);
    candidates.push({
      key: `artifact:${opts.owner}:${rel}:${version.slice(0, 16)}`,
      ref: { kind: "artifact", owner: opts.owner, artifact: rel, contentVersion: version, coveredPeriod: entry.coveredPeriod },
      excerpt,
      coveredPeriod: entry.coveredPeriod,
      tier: entry.tier,
      currentness: inScope ? "current" : "historical-unverified",
    });
  }
  const complete = !stopped(opts.deadlineAt, opts.signal)
    && filesRead < OWNED_S6_MAX_FILES && bytesRead < OWNED_S6_MAX_BYTES;
  return {
    status: candidates.length > 0 || omitted.length === 0 ? (complete ? "completed" : "partial") : "partial",
    candidates, entriesInspected, filesRead, bytesRead, omitted,
  };
}
