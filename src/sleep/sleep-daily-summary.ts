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

/** Summary produced from the messages actually read, plus their window. */
export interface DailySummaryResult {
  /** Trimmed, capped summary text. */
  readonly summary: string;
  /** Timestamp of the earliest summarized message. */
  readonly startTs: number;
  /** Timestamp of the latest summarized message. */
  readonly endTs: number;
}

import { writeFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { sanitizeForSummary } from "../media-sanitizer.js";
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
  /** For catch-up: read messages within date range instead of watermark. */
  dateRange?: { startTs: number; endTs: number };
}

type Message = { id: number; role: string; content: string; timestamp: number };

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
    `SELECT id, role, content, timestamp FROM messages WHERE user_id = ? AND timestamp > ? ${SESSION_FILTER_A} ORDER BY timestamp ASC`,
  ).all(userId, watermarkTs) as Message[];
}

/** Read Code (C) messages since watermark. */
export function readCodeMessages(db: Database.Database, userId: string, watermarkTs: number): Message[] {
  return db.prepare(
    `SELECT id, role, content, timestamp FROM messages WHERE user_id = ? AND timestamp > ? ${SESSION_FILTER_C} ORDER BY timestamp ASC`,
  ).all(userId, watermarkTs) as Message[];
}

/** Read Main (A) messages within a date range (for catch-up). */
export function readMessagesByDateRange(db: Database.Database, userId: string, startTs: number, endTs: number): Message[] {
  return db.prepare(
    `SELECT id, role, content, timestamp FROM messages WHERE user_id = ? AND timestamp >= ? AND timestamp < ? ${SESSION_FILTER_A} ORDER BY timestamp ASC`,
  ).all(userId, startTs, endTs) as Message[];
}

/** Read Code (C) messages within a date range (for catch-up). */
export function readCodeMessagesByDateRange(db: Database.Database, userId: string, startTs: number, endTs: number): Message[] {
  return db.prepare(
    `SELECT id, role, content, timestamp FROM messages WHERE user_id = ? AND timestamp >= ? AND timestamp < ? ${SESSION_FILTER_C} ORDER BY timestamp ASC`,
  ).all(userId, startTs, endTs) as Message[];
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
  const rawMain = config.dateRange
    ? readMessagesByDateRange(db, config.userId, config.dateRange.startTs, config.dateRange.endTs)
    : readMessages(db, config.userId, config.watermarkTs);
  const rawCode = config.dateRange
    ? readCodeMessagesByDateRange(db, config.userId, config.dateRange.startTs, config.dateRange.endTs)
    : readCodeMessages(db, config.userId, config.watermarkTs);

  // Filter garbage-marked messages
  const garbageIds = loadGarbageIds(config.memoryDir);
  const mainMessages = rawMain.filter(m => !garbageIds.has(m.id) && !m.content.startsWith("[SYSTEM"));
  const codeMessages = rawCode.filter(m => !garbageIds.has(m.id) && !m.content.startsWith("[SYSTEM"));
  const messages = [...mainMessages, ...codeMessages].sort((a, b) => a.timestamp - b.timestamp);

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
    const prompt = buildPrompt(null, sections.join("\n\n"));
    try {
      const summary = await sendPrompt(prompt);
      return { summary: capSummary(summary.trim(), summaryTargetTokens), startTs, endTs };
    } catch (err) {
      if (err instanceof LLMUnavailableError) throw err;
      logWarn(TAG, "Single shot failed, trying aggressive");
      try {
        const summary = await sendPrompt(buildAggressivePrompt(null, sections.join("\n\n")));
        return { summary: capSummary(summary.trim(), summaryTargetTokens), startTs, endTs };
      } catch (err2) {
        if (err2 instanceof LLMUnavailableError) throw err2;
        logWarn(TAG, "Aggressive failed, using fallback");
        return { summary: deterministicFallback(messages), startTs, endTs };
      }
    }
  }

  // Batched accumulating summary. A failed batch is skipped, so the covered
  // window tracks the first and last batches that actually contributed.
  const batches = chunkMessages(messages, effectiveBudget);
  logInfo(TAG, `Batching: ${batches.length} batches (budget ${Math.round(effectiveBudget)} tokens)`);

  let summary: string | null = null;
  let coveredStartTs: number | null = null;
  let coveredEndTs: number | null = null;

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
    } catch (err) {
      if (err instanceof LLMUnavailableError) throw err;
      logWarn(TAG, `Batch ${i + 1} normal failed, trying aggressive`);
      try {
        const result = await sendPrompt(buildAggressivePrompt(summary, messagesText));
        summary = capSummary(result.trim(), summaryTargetTokens);
        coveredStartTs ??= batchStartTs;
        coveredEndTs = batchEndTs;
      } catch (err2) {
        if (err2 instanceof LLMUnavailableError) throw err2;
        logWarn(TAG, `Batch ${i + 1} aggressive failed, using fallback`);
        if (!summary) {
          summary = deterministicFallback(batch);
          coveredStartTs ??= batchStartTs;
          coveredEndTs = batchEndTs;
        }
        // Keep existing summary, skip this batch
      }
    }
  }

  if (summary === null) return null;
  return { summary, startTs: coveredStartTs ?? startTs, endTs: coveredEndTs ?? endTs };
}

/**
 * Write the daily summary file. Returns the path.
 *
 * The filename is the UTC write instant (`daily_YYYY-MM-DD-HHMMZ.md`) and
 * carries no window meaning; the canonical covered period lives in the first
 * content line (`# Daily Summary <date>` or `<start> — <end>`, UTC days).
 *
 * **Supersede policy (#1821):** before writing, delete earlier `daily_*`
 * files whose covered period is contained in the new window, so retries and
 * catch-ups leave exactly one canonical file instead of overlapping
 * summaries. Containment only: a partial overlap implies a watermark anomaly,
 * and there keeping both files (no data loss) beats deleting one. Files
 * without a parseable heading, non-daily files, and the new file itself (it
 * is written after supersede) are never deleted — fail closed.
 */
export function writeDailyFile(
  memoryDir: string,
  coveredStartMs: number,
  coveredEndMs: number,
  content: string,
  writtenAtMs: number = Date.now(),
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

  // Supersede first so the new file can never delete itself.
  deleteSupersededByContent(dir, startDay, endDay);
  const path = join(dir, dailyWriteFilename(writtenAtMs));
  writeFileSync(path, redactSecrets(`${formatDailyHeading(startDay, endDay)}\n\n${content}\n`));
  logInfo(TAG, `Written ${path} (${content.length} chars, covers ${startDay}..${endDay})`);
  return path;
}

function deleteSupersededByContent(dir: string, startDay: string, endDay: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const f of entries) {
    if (!f.startsWith("daily_") || !f.endsWith(".md")) continue;
    let firstLine: string;
    try {
      const raw = readFileSync(join(dir, f), "utf-8");
      const newline = raw.indexOf("\n");
      firstLine = newline === -1 ? raw : raw.slice(0, newline);
    } catch {
      continue;
    }
    const period = parseDailyHeading(firstLine);
    if (!period) continue; // fail closed on unparseable headings
    if (period.startDay >= startDay && period.endDay <= endDay) {
      try {
        unlinkSync(join(dir, f));
        logInfo(TAG, `Superseded daily file deleted: ${f} (covered by ${startDay}..${endDay})`);
      } catch { /* best-effort; leave as-is if the delete fails */ }
    }
  }
}
