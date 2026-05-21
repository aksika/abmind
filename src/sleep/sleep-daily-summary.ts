/**
 * Sleep daily summary — code-driven batched summarization.
 * Reads messages from DB, batches by token budget, accumulates summary.
 */

import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { sanitizeForSummary } from "../media-sanitizer.js";
import { logInfo, logWarn, logDebug } from "../mem-logger.js";
import { redactSecrets } from "../redact-secrets.js";
import type Database from "better-sqlite3";

/** Load garbage-marked message IDs from garbage.json. */
function loadGarbageIds(memoryDir: string): Set<number> {
  const ids = new Set<number>();
  try {
    const garbagePath = join(memoryDir, "garbage.json");
    if (!existsSync(garbagePath)) return ids;
    const raw = JSON.parse(readFileSync(garbagePath, "utf-8"));
    const entries = Array.isArray(raw) ? raw : (raw?.messages ?? []);
    for (const e of entries) { if (e?.messageId) ids.add(e.messageId); }
  } catch { /* */ }
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

/** Session filter: Main (A) sessions + pre-migration messages (empty/old-format session_id). */
const MAIN_SESSION_FILTER = "AND (session_id LIKE '%\\_A\\_%' ESCAPE '\\' OR session_id LIKE '%\\_C\\_%' ESCAPE '\\' OR session_id = '' OR session_id NOT LIKE '%\\_%\\_%' ESCAPE '\\')";

/** Read messages since watermark, sanitize media. */
export function readMessages(db: Database.Database, userId: string, watermarkTs: number): Message[] {
  return db.prepare(
    `SELECT id, role, content, timestamp FROM messages WHERE user_id = ? AND timestamp > ? ${MAIN_SESSION_FILTER} ORDER BY timestamp ASC`,
  ).all(userId, watermarkTs) as Message[];
}

/** Read messages within a date range (for catch-up). */
export function readMessagesByDateRange(db: Database.Database, userId: string, startTs: number, endTs: number): Message[] {
  return db.prepare(
    `SELECT id, role, content, timestamp FROM messages WHERE user_id = ? AND timestamp >= ? AND timestamp < ? ${MAIN_SESSION_FILTER} ORDER BY timestamp ASC`,
  ).all(userId, startTs, endTs) as Message[];
}

/** Format messages for the prompt. */
function formatMessages(messages: Message[]): string {
  return messages.map(m => `[${m.role}] ${sanitizeForSummary(m.content)}`).join("\n").trim();
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
 * Returns the summary text, or null if no messages.
 */
export async function buildDailySummary(
  db: Database.Database,
  sendPrompt: SendPromptFn,
  config: DailySummaryConfig,
): Promise<string | null> {
  const rawMessages = config.dateRange
    ? readMessagesByDateRange(db, config.userId, config.dateRange.startTs, config.dateRange.endTs)
    : readMessages(db, config.userId, config.watermarkTs);

  // Filter garbage-marked messages
  const garbageIds = loadGarbageIds(config.memoryDir);
  const messages = rawMessages.filter(m => !garbageIds.has(m.id) && !m.content.startsWith("[SYSTEM"));
  if (messages.length === 0) {
    logInfo(TAG, `No messages to summarize (${rawMessages.length} raw, ${garbageIds.size} garbage filtered)`);
    return null;
  }

  logInfo(TAG, `Processing ${messages.length} messages (${rawMessages.length - messages.length} garbage/system filtered)`);

  // Estimate total tokens
  const totalTokens = messages.reduce(
    (sum, m) => sum + estimateTokens(sanitizeForSummary(m.content)),
    0,
  ) * SAFETY_MARGIN;

  const effectiveBudget = (config.ctxWindow * CHUNK_RATIO) - OVERHEAD_TOKENS;
  const summaryTargetTokens = Math.floor(effectiveBudget * 0.3); // ~30% of budget for summary

  // Single shot or batched?
  if (totalTokens < config.ctxWindow * SINGLE_SHOT_RATIO) {
    logInfo(TAG, `Single shot (${Math.round(totalTokens)} tokens, ctx ${config.ctxWindow})`);
    const prompt = buildPrompt(null, formatMessages(messages));
    try {
      const summary = await sendPrompt(prompt);
      return capSummary(summary.trim(), summaryTargetTokens);
    } catch (err) {
      if (err instanceof LLMUnavailableError) throw err;
      logWarn(TAG, "Single shot failed, trying aggressive");
      try {
        const summary = await sendPrompt(buildAggressivePrompt(null, formatMessages(messages)));
        return capSummary(summary.trim(), summaryTargetTokens);
      } catch (err2) {
        if (err2 instanceof LLMUnavailableError) throw err2;
        logWarn(TAG, "Aggressive failed, using fallback");
        return deterministicFallback(messages);
      }
    }
  }

  // Batched accumulating summary
  const batches = chunkMessages(messages, effectiveBudget);
  logInfo(TAG, `Batching: ${batches.length} batches (budget ${Math.round(effectiveBudget)} tokens)`);

  let summary: string | null = null;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    const messagesText = formatMessages(batch);
    logDebug(TAG, `Batch ${i + 1}/${batches.length}: ${batch.length} messages`);

    const prompt = buildPrompt(summary, messagesText);

    try {
      const result = await sendPrompt(prompt);
      summary = capSummary(result.trim(), summaryTargetTokens);
    } catch (err) {
      if (err instanceof LLMUnavailableError) throw err;
      logWarn(TAG, `Batch ${i + 1} normal failed, trying aggressive`);
      try {
        const result = await sendPrompt(buildAggressivePrompt(summary, messagesText));
        summary = capSummary(result.trim(), summaryTargetTokens);
      } catch (err2) {
        if (err2 instanceof LLMUnavailableError) throw err2;
        logWarn(TAG, `Batch ${i + 1} aggressive failed, using fallback`);
        if (!summary) {
          summary = deterministicFallback(batch);
        }
        // Keep existing summary, skip this batch
      }
    }
  }

  return summary;
}

/**
 * Write the daily summary file. Returns the path.
 *
 * Single-day: `daily_<date>.md` with heading `# Daily Summary <date>`.
 * Interval:   `daily_<start>_to_<end>.md` with heading `# Daily Summary <start> — <end>`.
 *
 * **Dedupe policy:** when writing an interval file covering `[start, end]`,
 * any existing `daily_<d>.md` where `start ≤ d ≤ end` is deleted. Downstream
 * consumers (memory extraction, weekly summary) glob `daily_*.md` — without
 * dedupe they would double-count the overlapping day. See plan #163 v11 section
 * "Interval-aware daily files" for the policy rationale.
 *
 * NOTE: the second argument accepts a legacy 2-arg call pattern from callers
 * that pass the directory differently. Keep backward compat: `writeDailyFile(dir, date, content)`
 * still works and is equivalent to a single-day write.
 */
export function writeDailyFile(memoryDir: string, dateStart: string, dateEndOrContent: string, maybeContent?: string): string {
  // Signature overload resolution. If the 4th arg is present, this is the interval-aware call.
  // If only 3 args, the 3rd is content (single-day, legacy).
  const isInterval = maybeContent !== undefined;
  const dateEnd = isInterval ? dateEndOrContent : dateStart;
  const content = isInterval ? maybeContent! : dateEndOrContent;

  const dir = join(memoryDir, "daily");
  mkdirSync(dir, { recursive: true });

  if (isInterval && dateEnd !== dateStart) {
    // Interval write — delete any single-day files inside [start, end].
    deleteSupersededSingleDay(dir, dateStart, dateEnd);
    const path = join(dir, `daily_${dateStart}_to_${dateEnd}.md`);
    writeFileSync(path, redactSecrets(`# Daily Summary ${dateStart} — ${dateEnd}\n\n${content}\n`));
    logInfo(TAG, `Written ${path} (${content.length} chars, interval)`);
    return path;
  }

  // Single-day write (either explicit same-day interval or legacy 3-arg call).
  const path = join(dir, `daily_${dateStart}.md`);
  writeFileSync(path, redactSecrets(`# Daily Summary ${dateStart}\n\n${content}\n`));
  logInfo(TAG, `Written ${path} (${content.length} chars)`);
  return path;
}

/** Delete any `daily_<d>.md` where `dateStart ≤ d ≤ dateEnd`. Interval files are left alone. */
function deleteSupersededSingleDay(dir: string, dateStart: string, dateEnd: string): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    // Only target single-day files of shape daily_YYYY-MM-DD.md
    const m = f.match(/^daily_(\d{4}-\d{2}-\d{2})\.md$/);
    if (!m) continue;
    const d = m[1]!;
    if (d >= dateStart && d <= dateEnd) {
      try {
        unlinkSync(join(dir, f));
        logInfo(TAG, `Superseded single-day file deleted: ${f} (covered by ${dateStart}..${dateEnd})`);
      } catch { /* best-effort; leave as-is if the delete fails */ }
    }
  }
}
