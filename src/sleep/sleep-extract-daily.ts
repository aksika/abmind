/**
 * Sleep extract-from-daily — reads the daily summary file and
 * asks the model to extract memories via abmind store.
 */

import { readFileSync } from "node:fs";
import { logInfo, logWarn } from "../mem-logger.js";
import { LLMUnavailableError } from "./sleep-daily-summary.js";

const TAG = "extract-daily";

/** #1653: the single daily-file viability floor shared by extraction and the
 *  final review — a second independently tunable threshold cannot drift. */
export const DAILY_FILE_MIN_CHARS = 50;

/**
 * #1653: deterministic daily-file viability predicate shared by extraction and
 * the final review. A missing or unreadable path is unusable — the path never
 * leaks into callers' output, findings, or reports.
 */
export function readDailyArtifact(dailyPath: string): { usable: boolean; content: string | null } {
  let raw: string;
  try {
    raw = readFileSync(dailyPath, "utf-8");
  } catch {
    return { usable: false, content: null };
  }
  const content = raw.trim();
  if (!content || content.length < DAILY_FILE_MIN_CHARS) {
    return { usable: false, content: null };
  }
  return { usable: true, content };
}

type SendPromptFn = (prompt: string) => Promise<string>;

const EXTRACTION_PROMPT = `Here is today's conversation summary:
---
{DAILY_CONTENT}
---

For EVERY meaningful point, store a memory using abmind store:

abmind store --translated "English" --original "original if known" --memory-type <fact|decision|preference|event> --emotion-score <-5 to +5> --chat-id {CHAT_ID}

Store:
- Facts about the user, their setup, people, life
- Decisions made (technical choices, configs, plans)
- Preferences ("I prefer X", "don't do Z")
- How the user wants things done (workflows, habits)
- Events and milestones
- Lessons learned
- Emotional moments worth remembering

Do NOT store:
- Agent output that the user rejected, dismissed, or corrected. If the user said "what?", "that's wrong", or expressed confusion about something the agent said — skip the entire exchange.

When in doubt, store it — dedup happens during sleep merge.
After storing all memories, respond with the count of memories stored.`;

/**
 * Extract memories from the daily summary file.
 * Returns the model's response (count of memories stored).
 */
export async function extractFromDaily(
  dailyPath: string,
  userId: string,
  sendPrompt: SendPromptFn,
): Promise<string> {
  const read = readDailyArtifact(dailyPath);
  if (!read.usable) {
    logInfo(TAG, "Daily file too short, skipping extraction");
    return "0 memories (daily file empty)";
  }
  const content = read.content!;

  const prompt = EXTRACTION_PROMPT
    .replace("{DAILY_CONTENT}", content)
    .replace("{CHAT_ID}", String(userId));

  logInfo(TAG, `Extracting from ${dailyPath} (${content.length} chars)`);

  try {
    const result = await sendPrompt(prompt);
    logInfo(TAG, `Extraction result: ${result.trim().slice(0, 100)}`);
    return result.trim();
  } catch (err) {
    if (err instanceof LLMUnavailableError) throw err;
    logWarn(TAG, `Extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    return "0 memories (extraction failed)";
  }
}
