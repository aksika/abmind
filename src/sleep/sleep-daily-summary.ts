/**
 * Sleep daily summary — code-driven batched summarization.
 * Reads messages from DB, batches by token budget, accumulates summary.
 */

/**
 * Daily filename/heading codec (#1821). One canonical identity rule shared by
 * the writer, supersede, and every reader:
 *
 * - Filename is the UTC write instant: `daily_YYYY-MM-DD-HHMMZ.md`.
 * - The first content line states the covered period and is the only
 *   source of window truth: `# Daily Summary <date>` or
 *   `# Daily Summary <start> — <end>` (em dash, inclusive, UTC days).
 */

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** UTC calendar-day label, YYYY-MM-DD. */
export function utcDayLabel(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Write-time filename for a UTC write instant: `daily_YYYY-MM-DD-HHMMZ.md`. */
export function dailyWriteFilename(writtenAtMs: number): string {
  const d = new Date(writtenAtMs);
  return `daily_${utcDayLabel(writtenAtMs)}-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}Z.md`;
}

const DAILY_WRITE_NAME_RE = /^daily_(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})Z\.md$/;

/** Parse a write-time filename to its UTC write timestamp, or null. */
export function parseDailyWrittenAt(filename: string): number | null {
  const m = filename.match(DAILY_WRITE_NAME_RE);
  if (!m) return null;
  const parts = [m[1]!, m[2]!, m[3]!, m[4]!, m[5]!].map(Number);
  const [year, month, day, hour, minute] = parts as [number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  return Date.UTC(year, month - 1, day, hour, minute);
}

const DAILY_LEGACY_NAME_RE = /^daily_(\d{4})-(\d{2})-(\d{2})\.md$/;

/** Parse a legacy covered-day filename to its UTC day label, or null. */
export function parseLegacyDailyDay(filename: string): string | null {
  const m = filename.match(DAILY_LEGACY_NAME_RE);
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  return isCalendarDay(day) ? day : null;
}

/** Parse a legacy covered-day filename to its UTC-midnight timestamp, or null. */
export function parseLegacyDailyWriteTs(filename: string): number | null {
  const day = parseLegacyDailyDay(filename);
  if (day === null) return null;
  const ts = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ts) ? ts : null;
}

/** Canonical first line: `# Daily Summary <day>` or `<start> — <end>`. */
export function formatDailyHeading(startDay: string, endDay: string): string {
  return startDay === endDay
    ? `# Daily Summary ${startDay}`
    : `# Daily Summary ${startDay} — ${endDay}`;
}

export interface DailyPeriod {
  readonly startDay: string;
  readonly endDay: string;
}

const DAILY_HEADING_RE = /^# Daily Summary (\d{4}-\d{2}-\d{2})(?: — (\d{4}-\d{2}-\d{2}))?$/;

function isCalendarDay(day: string): boolean {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const date = Number(m[3]);
  if (month < 1 || month > 12 || date < 1) return false;
  // Real month length (leap years included) so malformed names never yield
  // a NaN timestamp downstream.
  return date <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Parse a daily file's first line into its inclusive covered-day range, or null. */
export function parseDailyHeading(firstLine: string): DailyPeriod | null {
  const m = firstLine.trim().match(DAILY_HEADING_RE);
  if (!m) return null;
  const startDay = m[1]!;
  const endDay = m[2] ?? startDay;
  if (!isCalendarDay(startDay) || !isCalendarDay(endDay) || endDay < startDay) return null;
  return { startDay, endDay };
}

/**
 * #1863: host-authored owner provenance. Written by `writeDailyFile()` as the
 * second content line (`Owner: <userId>`); readers treat a missing or
 * malformed line as unattributed (fail closed — never guessed). A title or
 * filename never establishes ownership.
 */
export function formatArtifactOwner(owner: string): string {
  return `Owner: ${owner}`;
}

const ARTIFACT_OWNER_RE = /^Owner: (.+)$/;

/** Parse verified owner provenance from an artifact's header lines, or null when unattributed. */
export function parseArtifactOwner(head: string): string | null {
  const lines = head.split("\n");
  const matchOwner = (line: string | undefined): string | null => {
    const m = line?.trim().match(ARTIFACT_OWNER_RE);
    if (!m) return null;
    const owner = m[1]!.trim();
    return owner === "" ? null : owner;
  };
  // Consolidations carry Owner as the first line; dailies on the line
  // directly after the `# Daily Summary` heading. Body text never matches,
  // so a legacy file cannot acquire forged provenance from its content.
  const first = matchOwner(lines[0]);
  if (first !== null) return first;
  if (lines[0]?.trim().startsWith("# Daily Summary")) return matchOwner(lines[1]);
  return null;
}

/** Summary produced from the messages actually read, plus their window. */
export interface DailySummaryResult {
  /** Trimmed, capped summary text. */
  readonly summary: string;
  /** Timestamp of the earliest summarized message. */
  readonly startTs: number;
  /** Timestamp of the latest summarized message. */
  readonly endTs: number;
  /** #1860: per-scope covered intervals (message ranges the output reflects). */
  readonly covered: ScopedInterval[];
  /** #1860: per-scope skipped intervals — batches both attempts failed for.
   *  Unclaimed by definition; they block watermark advance past them. */
  readonly skipped: ScopedInterval[];
  /** #1860: deliberately excluded input (garbage marks, `[SYSTEM` prefix),
   *  merged per reason. Audit markers; flush-time SQL is the enforcement. */
  readonly excluded: ExcludedInterval[];
}

import { writeFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync, existsSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname, relative, resolve } from "node:path";
import { sanitizeForSummary } from "../media-sanitizer.js";
import { scopeOfSession, mergeExcluded } from "./coverage.js";
import type { CoverageInterval, ExcludedInterval, ScopedInterval } from "./coverage.js";
import { logInfo, logWarn, logDebug } from "../mem-logger.js";
import { redactSecrets } from "../redact-secrets.js";
import type Database from "better-sqlite3";
import { stripWakeUpQuestionMarker } from "../wake-up-question.js";
import { readGcMarks } from "./gc-codec.js";

/** Load garbage-marked message IDs via the shared strict codec (#1807).
 *  Incompatible shapes yield no trusted marks (fail closed). */
function loadGarbageIds(memoryDir: string): Set<number> {
  const ids = new Set<number>();
  const status = readGcMarks(memoryDir);
  if (status.kind === "ok") {
    for (const id of status.marks.keys()) ids.add(id);
  }
  return ids;
}

const TAG = "daily-summary";

/** Estimate tokens from text length (~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const SAFETY_MARGIN = 1.2;
const OVERHEAD_TOKENS = 4096;
const CHUNK_RATIO = 0.4;
const SINGLE_SHOT_RATIO = 0.7;
const SUMMARY_CAP_FACTOR = 3;

export interface DailySummaryConfig {
  ctxWindow: number; // AGENT_SLEEP_CTX_WINDOW
  memoryDir: string;
  userId: string;
  watermarkTs: number;
}

type Message = { id: number; role: string; content: string; timestamp: number; session_id: string };

type SendPromptFn = (prompt: string) => Promise<string>;

/**
 * Thrown when the LLM is unavailable (all retries exhausted).
 * Distinguishes "LLM entirely failed" from "LLM responded but returned empty/short."
 * Callers of buildDailySummary/extractFromDaily should let this propagate — do not
 * fall through to deterministic fallback; the orchestrator marks the step failed.
 */
export class LLMUnavailableError extends Error {
  constructor(message = "LLM unavailable (all retries exhausted)") {
    super(message);
    this.name = "LLMUnavailableError";
  }
}

/** Session filter: Main (A) + Code (C) + pre-migration messages. */
const SESSION_FILTER_A = "AND (session_id LIKE '%\\_A\\_%' ESCAPE '\\' OR session_id = '' OR session_id NOT LIKE '%\\_%\\_%' ESCAPE '\\')";
const SESSION_FILTER_C = "AND session_id LIKE '%\\_C\\_%' ESCAPE '\\'";

/** Read Main (A) messages since watermark. */
export function readMessages(db: Database.Database, userId: string, watermarkTs: number): Message[] {
  return db.prepare(
    `SELECT id, role, content, timestamp, session_id FROM messages WHERE user_id = ? AND timestamp > ? ${SESSION_FILTER_A} ORDER BY timestamp ASC`,
  ).all(userId, watermarkTs) as Message[];
}

/** Read Code (C) messages since watermark. */
export function readCodeMessages(db: Database.Database, userId: string, watermarkTs: number): Message[] {
  return db.prepare(
    `SELECT id, role, content, timestamp, session_id FROM messages WHERE user_id = ? AND timestamp > ? ${SESSION_FILTER_C} ORDER BY timestamp ASC`,
  ).all(userId, watermarkTs) as Message[];
}

/** Format messages for the prompt. */
function formatMessages(messages: Message[]): string {
  return messages.map(m => `[${m.role}] ${sanitizeForSummary(stripWakeUpQuestionMarker(m.content))}`).join("\n").trim();
}

/** Chunk messages into batches by token budget. */
export function chunkMessages(messages: Message[], budgetTokens: number): Message[][] {
  const batches: Message[][] = [];
  let current: Message[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const tokens = estimateTokens(sanitizeForSummary(msg.content)) * SAFETY_MARGIN;
    if (current.length > 0 && currentTokens + tokens > budgetTokens) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(msg);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Cap summary if it exceeds target * CAP_FACTOR. */
function capSummary(summary: string, targetTokens: number): string {
  const tokens = estimateTokens(summary);
  const max = targetTokens * SUMMARY_CAP_FACTOR;
  if (tokens <= max) return summary;
  const maxChars = max * 4;
  return summary.slice(0, maxChars) + `\n[Capped from ${tokens} to ~${max} tokens]`;
}

/** Partition messages into one timestamp interval per session scope (#1860).
 *  A scope with no messages yields no interval. */
function scopeIntervals(messages: Message[]): ScopedInterval[] {
  const spans = new Map<"A" | "C", { startTs: number; endTs: number }>();
  for (const m of messages) {
    const scope = scopeOfSession(m.session_id);
    const cur = spans.get(scope);
    if (!cur) spans.set(scope, { startTs: m.timestamp, endTs: m.timestamp });
    else {
      cur.startTs = Math.min(cur.startTs, m.timestamp);
      cur.endTs = Math.max(cur.endTs, m.timestamp);
    }
  }
  return [...spans.entries()].map(([scope, span]) => ({ scope, ...span }));
}

/** Build the batch prompt. */
function buildPrompt(previousSummary: string | null, messagesText: string): string {
  const summarySection = previousSummary
    ? `Here is the running summary of today's conversations:\n---\n${previousSummary}\n---`
    : "No previous summary — this is the first batch.";

  return `${summarySection}

Here are the next messages (chronological):
---
${messagesText}
---

Update the summary incorporating these new messages.

MUST PRESERVE:
- Topics discussed and their outcomes
- Decisions made and rationale
- User preferences expressed (explicit or implicit)
- How the user wants things done (workflows, habits)
- Events and milestones
- Emotional moments (frustration, excitement, humor)
- Technical details worth remembering
- Active tasks and their status
- Open questions and follow-ups
- All identifiers exactly (UUIDs, IPs, paths, names)

SKIP:
- Greetings, filler, small talk
- Debugging noise, tool execution details
- Transient errors and temporary states

Write concise English bullet points, chronological order.`;
}

/** Aggressive retry prompt. */
function buildAggressivePrompt(previousSummary: string | null, messagesText: string): string {
  return buildPrompt(previousSummary, messagesText) +
    "\n\nBe MORE CONCISE. Focus on key facts, decisions, and preferences only. Maximum 20 bullet points.";
}

/** Deterministic fallback — truncate messages to bullet points. */
function deterministicFallback(messages: Message[]): string {
  const lines = messages
    .filter(m => m.role === "user")
    .map(m => {
      const clean = sanitizeForSummary(m.content).slice(0, 100);
      return `- ${clean}`;
    })
    .slice(0, 30);
  return `[Fallback summary — LLM unavailable]\n${lines.join("\n")}`;
}

/**
 * Build the daily summary with accumulating batches.
 * Returns the summary with the window it actually summarized, or null when
 * there are no messages (the caller skips the write).
 */
export async function buildDailySummary(
  db: Database.Database,
  sendPrompt: SendPromptFn,
  config: DailySummaryConfig,
): Promise<DailySummaryResult | null> {
  const rawMain = readMessages(db, config.userId, config.watermarkTs);
  const rawCode = readCodeMessages(db, config.userId, config.watermarkTs);

  // Filter garbage-marked messages
  const garbageIds = loadGarbageIds(config.memoryDir);
  // #1860: dropped input is an explicit exclusion with a reason, not an
  // omission. Per-message timestamps; merged per reason for the claim.
  const excludedMarks: Array<CoverageInterval & { reason: string }> = [];
  const isExcluded = (m: { id: number; content: string; timestamp: number }): boolean => {
    if (garbageIds.has(m.id)) {
      excludedMarks.push({ startTs: m.timestamp, endTs: m.timestamp, reason: "garbage-marked" });
      return true;
    }
    if (m.content.startsWith("[SYSTEM")) {
      excludedMarks.push({ startTs: m.timestamp, endTs: m.timestamp, reason: "system-prefix" });
      return true;
    }
    return false;
  };
  const mainMessages = rawMain.filter(m => !isExcluded(m));
  const codeMessages = rawCode.filter(m => !isExcluded(m));
  const messages = [...mainMessages, ...codeMessages].sort((a, b) => a.timestamp - b.timestamp);
  const excluded = mergeExcluded(excludedMarks);

  if (messages.length === 0) {
    logInfo(TAG, `No messages to summarize (${rawMain.length + rawCode.length} raw, ${garbageIds.size} garbage filtered)`);
    return null;
  }

  logInfo(TAG, `Processing ${messages.length} messages (main=${mainMessages.length}, code=${codeMessages.length})`);

  // Build type-sectioned formatted content for the prompt
  const sections: string[] = [];
  if (mainMessages.length > 0) {
    sections.push(`--- Main sessions ---\nExtract: facts, preferences, emotions, personal decisions\n\n${formatMessages(mainMessages)}`);
  }
  if (codeMessages.length > 0) {
    sections.push(`--- Code sessions ---\nExtract: architecture decisions, patterns learned, recurring bugs, tooling choices\n\n${formatMessages(codeMessages)}`);
  }

  // Estimate total tokens
  const totalTokens = messages.reduce(
    (sum, m) => sum + estimateTokens(sanitizeForSummary(m.content)),
    0,
  ) * SAFETY_MARGIN;

  const effectiveBudget = (config.ctxWindow * CHUNK_RATIO) - OVERHEAD_TOKENS;
  const summaryTargetTokens = Math.floor(effectiveBudget * 0.3); // ~30% of budget for summary

  // The covered window is the messages this run actually summarizes.
  const startTs = messages[0]!.timestamp;
  const endTs = messages[messages.length - 1]!.timestamp;

  // Single shot or batched?
  if (totalTokens < config.ctxWindow * SINGLE_SHOT_RATIO) {
    logInfo(TAG, `Single shot (${Math.round(totalTokens)} tokens, ctx ${config.ctxWindow})`);
    const covered = scopeIntervals(messages);
    const result = { covered, skipped: [] as ScopedInterval[], excluded };
    const prompt = buildPrompt(null, sections.join("\n\n"));
    try {
      const summary = await sendPrompt(prompt);
      return { summary: capSummary(summary.trim(), summaryTargetTokens), startTs, endTs, ...result };
    } catch (err) {
      if (err instanceof LLMUnavailableError) throw err;
      logWarn(TAG, "Single shot failed, trying aggressive");
      try {
        const summary = await sendPrompt(buildAggressivePrompt(null, sections.join("\n\n")));
        return { summary: capSummary(summary.trim(), summaryTargetTokens), startTs, endTs, ...result };
      } catch (err2) {
        if (err2 instanceof LLMUnavailableError) throw err2;
        logWarn(TAG, "Aggressive failed, using fallback");
        return { summary: deterministicFallback(messages), startTs, endTs, ...result };
      }
    }
  }

  // Batched accumulating summary. A failed batch is skipped, so the covered
  // window tracks the first and last batches that actually contributed.
  // #1860: each batch additionally reports per-scope covered intervals when
  // it contributes, or per-scope skipped (unclaimed) intervals when both
  // attempts fail — the accumulated summary stays usable either way.
  const batches = chunkMessages(messages, effectiveBudget);
  logInfo(TAG, `Batching: ${batches.length} batches (budget ${Math.round(effectiveBudget)} tokens)`);

  let summary: string | null = null;
  let coveredStartTs: number | null = null;
  let coveredEndTs: number | null = null;
  const covered: ScopedInterval[] = [];
  const skipped: ScopedInterval[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const batchStartTs = batch[0]!.timestamp;
    const batchEndTs = batch[batch.length - 1]!.timestamp;
    const messagesText = formatMessages(batch);
    logDebug(TAG, `Batch ${i + 1}/${batches.length}: ${batch.length} messages`);

    const prompt = buildPrompt(summary, messagesText);

    try {
      const result = await sendPrompt(prompt);
      summary = capSummary(result.trim(), summaryTargetTokens);
      coveredStartTs ??= batchStartTs;
      coveredEndTs = batchEndTs;
      covered.push(...scopeIntervals(batch));
    } catch (err) {
      if (err instanceof LLMUnavailableError) throw err;
      logWarn(TAG, `Batch ${i + 1} normal failed, trying aggressive`);
      try {
        const result = await sendPrompt(buildAggressivePrompt(summary, messagesText));
        summary = capSummary(result.trim(), summaryTargetTokens);
        coveredStartTs ??= batchStartTs;
        coveredEndTs = batchEndTs;
        covered.push(...scopeIntervals(batch));
      } catch (err2) {
        if (err2 instanceof LLMUnavailableError) throw err2;
        logWarn(TAG, `Batch ${i + 1} aggressive failed, using fallback`);
        if (!summary) {
          summary = deterministicFallback(batch);
          coveredStartTs ??= batchStartTs;
          coveredEndTs = batchEndTs;
          covered.push(...scopeIntervals(batch));
        } else {
          // Keep existing summary, skip this batch — the range stays
          // unclaimed and blocks watermark advance past it.
          skipped.push(...scopeIntervals(batch));
        }
      }
    }
  }

  if (summary === null) return null;
  return { summary, startTs: coveredStartTs ?? startTs, endTs: coveredEndTs ?? endTs, covered, skipped, excluded };
}

/**
 * Write the daily summary file. Returns the path.
 *
 * The filename is the UTC write instant (`daily_YYYY-MM-DD-HHMMZ.md`) and
 * carries no window meaning; the canonical covered period lives in the first
 * content line (`# Daily Summary <date>` or `<start> — <end>`, UTC days).
 *
 * **Supersede policy (#1821, publish-then-supersede #1905):** the new
 * artifact is published atomically (temp file plus rename, so a failed write
 * preserves the previous valid artifact) before earlier `daily_*` files
 * whose covered period is contained in the new window are retired, so retries
 * leave exactly one canonical file instead of overlapping summaries. The
 * newly published path is excluded from cleanup. Containment only: a partial
 * overlap implies a watermark anomaly, and there keeping both files (no data
 * loss) beats deleting one. Files without a parseable heading and non-daily
 * files are never deleted — fail closed.
 *
 * **Owner rule (#1863):** when `owner` is supplied, only files with verified
 * matching owner provenance are superseded; unattributed legacy and foreign
 * files survive and are handled by provenance filtering instead.
 *
 * **Honest windows (#1860):** when `coverage.skipped` is non-empty the
 * artifact carries explicit gap lines (a day-granularity heading cannot
 * express sub-day holes) and supersede is skipped entirely for the write —
 * a file with holes never deletes a file that may have covered them.
 *
 * **Write-path collision:** a same-minute `daily_...HHMMZ` path already
 * holding a non-supersede-eligible artifact (foreign, unattributed,
 * unparseable, or partially overlapping) is preserved — the new artifact
 * takes the next free minute-stamped path instead of overwriting it.
 * Re-covering messages is permitted; double-applying accepted memories
 * is not.
 */
export function writeDailyFile(
  memoryDir: string,
  coveredStartMs: number,
  coveredEndMs: number,
  content: string,
  writtenAtMs: number = Date.now(),
  owner?: string,
  coverage?: { covered: ScopedInterval[]; skipped: ScopedInterval[] },
): string {
  if (!Number.isFinite(coveredStartMs) || !Number.isFinite(coveredEndMs) || !Number.isFinite(writtenAtMs)) {
    throw new Error("writeDailyFile needs finite coveredStartMs, coveredEndMs, and writtenAtMs");
  }
  const lo = Math.min(coveredStartMs, coveredEndMs);
  const hi = Math.max(coveredStartMs, coveredEndMs);
  const startDay = utcDayLabel(lo);
  const endDay = utcDayLabel(hi);

  const dir = join(memoryDir, "daily");
  mkdirSync(dir, { recursive: true });

  const holes = coverage?.skipped ?? [];
  const ownerLine = owner ? `${formatArtifactOwner(owner)}\n` : "";
  const gapLines = holes.length > 0
    ? `Coverage gaps (unclaimed, covered again by the next normal run): ${holes.map(h => `${new Date(h.startTs).toISOString()}..${new Date(h.endTs).toISOString()}`).join(", ")}\n`
    : "";
  const payload = redactSecrets(`${formatDailyHeading(startDay, endDay)}\n${ownerLine}${gapLines}\n${content}\n`);
  // Same-path collision with a non-supersede-eligible artifact preserves the
  // previous file: the new artifact takes the next free minute-stamped path.
  // A byte-identical or supersede-eligible occupant is safely replaced.
  let probeMs = writtenAtMs;
  let path = join(dir, dailyWriteFilename(probeMs));
  for (let attempt = 0; ; attempt++) {
    if (!existsSync(path)) break;
    const existing = readFileSync(path, "utf-8");
    if (existing === payload || isSupersedeEligible(existing, startDay, endDay, owner)) break;
    if (attempt >= 4) {
      throw new Error(`writeDailyFile refused: no free minute-stamped path near ${path}`);
    }
    probeMs += 60_000;
    path = join(dir, dailyWriteFilename(probeMs));
  }
  const tempPath = join(dir, `.${dailyWriteFilename(probeMs)}.tmp-${randomUUID().slice(0, 8)}`);
  try {
    writeFileSync(tempPath, payload);
    renameSync(tempPath, path);
  } catch (err) {
    try { unlinkSync(tempPath); } catch { /* temp may not exist; target was never replaced */ }
    throw err;
  }
  // Publish-then-supersede: retire fully contained same-owner files only
  // after the replacement is durable — unless the new window has holes, in
  // which case nothing is deleted (fail closed).
  if (holes.length === 0) {
    deleteSupersededByContent(dir, startDay, endDay, owner, path);
  } else {
    logInfo(TAG, `Skipping supersede: ${holes.length} unclaimed range(s) in the new window`);
  }
  logInfo(TAG, `Written ${path} (${content.length} chars, covers ${startDay}..${endDay})`);
  return path;
}

/** Whether an existing daily artifact may be retired by a new covering window. */
function isSupersedeEligible(existing: string, startDay: string, endDay: string, owner?: string): boolean {
  const head = existing.split("\n").slice(0, 5).join("\n");
  const newline = head.indexOf("\n");
  const firstLine = newline === -1 ? head : head.slice(0, newline);
  const period = parseDailyHeading(firstLine);
  if (!period) return false; // fail closed on unparseable headings
  // #1863: a run may only supersede its own principal's files. Unattributed
  // legacy and verified foreign-owner files are kept — excluded from reads
  // by provenance filtering, never silently deleted. Without an owner
  // (legacy/test callers) the previous delete-by-containment applies.
  if (owner !== undefined) {
    const fileOwner = parseArtifactOwner(head);
    if (fileOwner !== owner) return false;
  }
  return period.startDay >= startDay && period.endDay <= endDay;
}

function deleteSupersededByContent(dir: string, startDay: string, endDay: string, owner: string | undefined, excludePath: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const f of entries) {
    if (!f.startsWith("daily_") || !f.endsWith(".md")) continue;
    const fullPath = join(dir, f);
    if (fullPath === excludePath) continue;
    let raw: string;
    try {
      raw = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }
    if (!isSupersedeEligible(raw, startDay, endDay, owner)) continue;
    try {
      unlinkSync(fullPath);
      logInfo(TAG, `Superseded daily file deleted: ${f} (covered by ${startDay}..${endDay})`);
    } catch { /* best-effort; leave as-is if the delete fails */ }
  }
}

// ── #1864 consolidation artifact codec ──────────────────────────────────────

/** The tier of a host-published consolidation artifact. */
export type ConsolidationTierName = "weekly" | "quarterly";

/** Inclusive declared period of a consolidation artifact (local date keys). */
export interface ConsolidationPeriod {
  readonly start: string;
  readonly end: string;
}

/**
 * Provider-neutral completion contract (#1864). The prompt requires the model
 * to end its response with this exact line; the host requires it as the last
 * nonblank content and strips it before writing. A response that stops
 * mid-section (the historical quarterly truncation: a 477-byte stub ending at
 * an empty "## Phase" heading, host-accepted because any nonempty text was
 * published) fails this check and leaves the period due.
 */
export const CONSOLIDATION_COMPLETE_MARKER = "===CONSOLIDATION-COMPLETE===";

/** Structural body rules shared by the response validator and the occupied-
 *  path check: nonempty, at least one heading, no empty non-title section.
 *  #1905: depth-aware — heading level determines ancestry (a same-or-shallower
 *  heading closes the current section; a level skip nests under the nearest
 *  deeper ancestor). A section is valid with direct non-blank prose or at least
 *  one transitively valid descendant; a leaf requires direct prose, so the
 *  final heading (always a leaf) may never be empty — the truncation signature.
 *  An empty sibling cannot borrow the next sibling's body since each section
 *  validates on its own subtree. */
function validateConsolidationBody(body: string): { ok: true } | { ok: false; detail: string } {
  if (body === "") return { ok: false, detail: "empty consolidation body" };
  const parseHeadingLevel = (line: string): number | null => {
    const match = line.trim().match(/^(#{1,6})\s+\S/);
    if (!match) return null;
    const hashes = match[1];
    if (hashes === undefined) return null;
    return hashes.length;
  };
  interface BodySection {
    readonly heading: string;
    readonly level: number;
    readonly children: BodySection[];
    directContent: number;
  }
  const roots: BodySection[] = [];
  const stack: BodySection[] = [];
  let headingCount = 0;
  let hasContent = false;
  for (const line of body.split("\n")) {
    const level = parseHeadingLevel(line);
    if (level === null) {
      if (line.trim() !== "") {
        hasContent = true;
        const current = stack[stack.length - 1];
        if (current !== undefined) current.directContent++;
      }
      continue;
    }
    headingCount++;
    const section: BodySection = { heading: line.trim(), level, children: [], directContent: 0 };
    let top = stack[stack.length - 1];
    while (top !== undefined && top.level >= level) {
      stack.pop();
      top = stack[stack.length - 1];
    }
    const parent = stack[stack.length - 1];
    if (parent !== undefined) parent.children.push(section);
    else roots.push(section);
    stack.push(section);
  }
  if (headingCount === 0) return { ok: false, detail: "missing heading" };
  const sectionValid = (section: BodySection): boolean => {
    if (section.directContent > 0) return true;
    return section.children.some(sectionValid);
  };
  const findInvalid = (sections: BodySection[], isTitleScope: boolean): string | null => {
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      if (section === undefined) continue;
      // Children first so the deepest empty section is reported.
      const childFailure = findInvalid(section.children, false);
      if (childFailure !== null) return childFailure;
      // The first heading is the positional document title and may be
      // followed directly by a section heading; every later heading must
      // open a valid section. A lone title still requires its own prose.
      const titleExempt = isTitleScope && i === 0 && headingCount > 1;
      if (!titleExempt && !sectionValid(section)) {
        return `empty section under heading "${section.heading}"`;
      }
    }
    return null;
  };
  const failure = findInvalid(roots, true);
  if (failure !== null) return { ok: false, detail: failure };
  if (!hasContent) {
    return { ok: false, detail: "no section content" };
  }
  return { ok: true };
}

/**
 * Validate a consolidation response against the completion contract: the
 * marker must be the last nonblank line, and the body after stripping it must
 * pass the structural rules. Returns the marker-stripped body on success.
 */
export function validateConsolidationCompletion(raw: string): { ok: true; body: string } | { ok: false; detail: string } {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let last = lines.length - 1;
  while (last >= 0 && lines[last]!.trim() === "") last--;
  if (last < 0 || lines[last]!.trim() !== CONSOLIDATION_COMPLETE_MARKER) {
    return { ok: false, detail: `missing terminal ${CONSOLIDATION_COMPLETE_MARKER} marker as the last content line` };
  }
  const body = lines.slice(0, last).join("\n").trim();
  const structure = validateConsolidationBody(body);
  if (!structure.ok) return structure;
  return { ok: true, body };
}

const CONSOLIDATION_PERIOD_START_RE = /^Period-Start: (\d{4}-\d{2}-\d{2})$/;
const CONSOLIDATION_PERIOD_END_RE = /^Period-End: (\d{4}-\d{2}-\d{2})$/;

/**
 * Parse the position-anchored declared period of a consolidation artifact.
 * Owner is line 1, `Period-Start` line 2, `Period-End` line 3; anything else
 * is not a checkpoint candidate.
 */
export function parseConsolidationPeriod(content: string): ConsolidationPeriod | null {
  const lines = content.split("\n");
  const start = lines[1]?.trim().match(CONSOLIDATION_PERIOD_START_RE)?.[1];
  const end = lines[2]?.trim().match(CONSOLIDATION_PERIOD_END_RE)?.[1];
  if (start === undefined || end === undefined) return null;
  if (!isCalendarDay(start) || !isCalendarDay(end) || end < start) return null;
  return { start, end };
}

/** Parse the position-anchored `Sources:` path list (line 4), or an empty list. */
export function parseConsolidationSources(content: string): string[] {
  const line = content.split("\n")[3]?.trim() ?? "";
  if (!line.startsWith("Sources:")) return [];
  return line.slice("Sources:".length).split(",").map((s) => s.trim()).filter((s) => s !== "");
}

/** Period-derived artifact filename: collision-free with legacy writer-date names. */
export function consolidationFileName(tier: ConsolidationTierName, period: ConsolidationPeriod): string {
  if (tier === "weekly") return `weekly_${period.start}_${period.end}.md`;
  const quarter = Math.floor((Number(period.start.slice(5, 7)) - 1) / 3) + 1;
  return `quarterly_${period.start.slice(0, 4)}-Q${quarter}.md`;
}

/** Header written above every consolidation body (position-anchored). */
function formatConsolidationHeader(pub: ConsolidationPublication): string {
  return `${formatArtifactOwner(pub.owner)}\n`
    + `Period-Start: ${pub.period.start}\n`
    + `Period-End: ${pub.period.end}\n`
    + `Sources: ${pub.sourcePaths.join(", ")}\n`
    + `Covered: ${pub.coveredRange}\n\n`;
}

export interface ConsolidationPublication {
  /** Verified run principal — becomes the artifact's owner provenance. */
  readonly owner: string;
  /** Tier and declared inclusive period — derive the artifact identity. */
  readonly tier: ConsolidationTierName;
  readonly period: ConsolidationPeriod;
  /** Human covered range (e.g. the selection's coveredRange). */
  readonly coveredRange: string;
  /** Absolute source daily paths bound to this publication. */
  readonly sourcePaths: readonly string[];
}

/**
 * #1863/#1864: host-published consolidation output. The model returns text;
 * abmind validates the completion contract, binds owner, declared period,
 * source artifacts, and covered range, and publishes to the period-derived
 * path. The model-written path is not part of the supported flow.
 *
 * Complete-or-fail: an incomplete response is refused before anything becomes
 * visible; the write goes to a temp file renamed over the target, so an
 * interrupted publication cannot be observed as an artifact. An occupied
 * period path holding a foreign or invalid artifact is refused rather than
 * overwritten; a verified same-owner same-period artifact may be replaced
 * (idempotent retry). Throws on any validation or write failure — callers
 * must surface that as a failed step, never as success.
 */
export function publishConsolidationFile(
  memoryDir: string,
  content: string,
  pub: ConsolidationPublication,
): string {
  const completion = validateConsolidationCompletion(content);
  if (!completion.ok) throw new Error(`publishConsolidationFile refused: ${completion.detail}`);
  if (!pub.owner.trim()) throw new Error("publishConsolidationFile refused: missing owner");
  const resolvedBase = resolve(memoryDir);
  const resolvedTarget = resolve(join(resolvedBase, pub.tier, consolidationFileName(pub.tier, pub.period)));
  // Containment: the target must stay inside the memory dir. The path is
  // host-derived, but validate anyway so a future caller cannot redirect it.
  const rel = relative(resolvedBase, resolvedTarget);
  if (rel === "" || rel.startsWith("..") || resolve(resolvedBase, rel) !== resolvedTarget) {
    throw new Error(`publishConsolidationFile refused: target escapes the memory dir (${resolvedTarget})`);
  }
  if (!resolvedTarget.endsWith(".md")) {
    throw new Error(`publishConsolidationFile refused: target is not a markdown file (${resolvedTarget})`);
  }
  if (existsSync(resolvedTarget)) {
    const existing = readFileSync(resolvedTarget, "utf-8");
    const existingPeriod = parseConsolidationPeriod(existing);
    const sameOwner = parseArtifactOwner(existing) === pub.owner;
    const samePeriod = existingPeriod?.start === pub.period.start && existingPeriod?.end === pub.period.end;
    // The header is position-fixed (Owner, Period-Start, Period-End, Sources,
    // Covered, blank); the body after it must be structurally complete.
    const existingBody = existing.split("\n").slice(5).join("\n").trim();
    if (!sameOwner || !samePeriod || !validateConsolidationBody(existingBody).ok) {
      throw new Error(`publishConsolidationFile refused: ${resolvedTarget} is occupied by a foreign or invalid artifact`);
    }
  }
  mkdirSync(dirname(resolvedTarget), { recursive: true });
  const tempPath = join(dirname(resolvedTarget), `.${consolidationFileName(pub.tier, pub.period)}.tmp-${randomUUID().slice(0, 8)}`);
  try {
    writeFileSync(tempPath, redactSecrets(`${formatConsolidationHeader(pub)}${completion.body}\n`));
    renameSync(tempPath, resolvedTarget);
  } catch (err) {
    try { unlinkSync(tempPath); } catch { /* temp may not exist; target was never replaced */ }
    throw err;
  }
  logInfo(TAG, `Published ${resolvedTarget} (${completion.body.length} chars, owner ${pub.owner}, ${pub.sourcePaths.length} sources)`);
  return resolvedTarget;
}
