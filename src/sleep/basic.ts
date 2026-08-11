/**
 * Basic sleep level — single-shot combined prompt.
 *
 * One LLM call. The model emits a daily summary + memory list in one turn,
 * abmind parses the output and persists both. Frontier-model-only — no retry,
 * no budget, no multi-step orchestration. Plan: docs/plans/163-sleep-to-abmind.md.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { logInfo, logWarn, logError } from "../mem-logger.js";
import { MemoryManager } from "../memory-manager.js";
import { writeDailyFile } from "./sleep-daily-summary.js";
import { sleepStepDeadlineMs } from "./step-deadlines.js";
import type { SleepRuntime } from "./contracts.js";
import type { MemoryConfig } from "../memory-config.js";

const TAG = "sleep-basic";

const VALID_TYPES = new Set(["fact", "decision", "preference", "event", "lesson", "feedback", "story"]);

/** Memory types accepted by the Basic prompt's `[type]` prefix. */
type MemoryType = "fact" | "decision" | "preference" | "event" | "lesson" | "feedback" | "story";

export interface BasicOpts {
  runtime: SleepRuntime;
  memoryConfig: MemoryConfig;
  userId: string;
  /** ISO date YYYY-MM-DD — start of the range (oldest). */
  dateStart: string;
  /** ISO date YYYY-MM-DD — end of the range (newest). Same as dateStart for single-day runs. */
  dateEnd: string;
  /** Pre-formatted messages block substituted into {MESSAGES}. */
  messages: string;
  /** Override prompt path for tests. */
  promptPath?: string;
}

export interface BasicResult {
  ok: boolean;
  dailyPath: string | null;
  memoriesStored: number;
  /** Non-fatal parse warnings (unknown types, malformed lines). */
  warnings: string[];
  /** Fatal error if the run failed. */
  error?: string;
}

/** Run the Basic one-shot cycle. Returns structured result instead of throwing. */
export async function runBasicCycle(opts: BasicOpts): Promise<BasicResult> {
  const warnings: string[] = [];

  // Load prompt template
  const promptPath = opts.promptPath ?? defaultPromptPath();
  let template: string;
  try {
    template = readFileSync(promptPath, "utf-8");
  } catch (err) {
    const msg = `Failed to read Basic prompt at ${promptPath}: ${err instanceof Error ? err.message : String(err)}`;
    logError(TAG, msg);
    return { ok: false, dailyPath: null, memoriesStored: 0, warnings, error: msg };
  }

  const prompt = template
    .replace(/\{DATE_START\}/g, opts.dateStart)
    .replace(/\{DATE_END\}/g, opts.dateEnd)
    .replace(/\{MESSAGES\}/g, opts.messages);

  // Call LLM. #1353: Basic is a single-shot cycle outside runSleepCycle's run
  // identity — synthesize a local runId/stepId/signal to satisfy the shared
  // SleepRuntime contract without inventing a second public API shape.
  // #1611: the basic level establishes its logical deadline before its single
  // runtime request.
  logInfo(TAG, `Basic cycle: ${opts.dateStart}..${opts.dateEnd}`);
  let rawResponse: string;
  try {
    rawResponse = await opts.runtime.complete({ prompt, stepId: "basic", runId: randomUUID(), signal: new AbortController().signal, deadlineAt: Date.now() + sleepStepDeadlineMs("basic") });
  } catch (err) {
    const msg = `LLM call failed: ${err instanceof Error ? err.message : String(err)}`;
    logError(TAG, msg);
    return { ok: false, dailyPath: null, memoriesStored: 0, warnings, error: msg };
  }

  if (!rawResponse || !rawResponse.trim()) {
    const msg = "LLM returned empty response";
    logError(TAG, msg);
    return { ok: false, dailyPath: null, memoriesStored: 0, warnings, error: msg };
  }

  // Parse
  const parsed = parseBasicResponse(rawResponse, warnings);
  if (!parsed.ok) {
    logRawResponse(opts.memoryConfig.memoryDir, rawResponse);
    return { ok: false, dailyPath: null, memoriesStored: 0, warnings, error: parsed.error };
  }

  // Write daily
  const dailyPath = opts.dateEnd === opts.dateStart
    ? writeDailyFile(opts.memoryConfig.memoryDir, opts.dateStart, parsed.daily)
    : writeDailyFile(opts.memoryConfig.memoryDir, opts.dateStart, opts.dateEnd, parsed.daily);
  logInfo(TAG, `Daily written: ${dailyPath}`);

  // Insert memories
  const memory = new MemoryManager(opts.memoryConfig);
  await memory.initialize({ skipEmbeddingCheck: true });
  let memoriesStored = 0;
  try {
    for (const m of parsed.memories) {
      const result = await memory.editor.instantStore({
        userId: opts.userId,
        contentEn: m.content,
        contentOriginal: m.content,
        memoryType: m.type,
        emotionScore: 0,
        confidence: 3,
        createdBy: "sleep:basic",
      });
      if (result.stored) {
        memoriesStored += result.memoriesCount;
      } else {
        const w = `Memory rejected (${m.type}): ${result.error ?? "unknown"}`;
        warnings.push(w);
        logWarn(TAG, w);
      }
    }
  } finally {
    memory.close();
  }

  logInfo(TAG, `🏁 Basic: ${memoriesStored} memories stored, ${warnings.length} warnings`);
  return { ok: true, dailyPath, memoriesStored, warnings };
}

interface ParsedResponse {
  ok: boolean;
  daily: string;
  memories: Array<{ type: MemoryType; content: string }>;
  error?: string;
}

/** Parse the Basic output. Exported for tests. */
export function parseBasicResponse(raw: string, warnings: string[]): ParsedResponse {
  // Strip leading/trailing markdown code fences — frontier models often wrap.
  const stripped = raw
    .replace(/^\s*```[a-zA-Z0-9_-]*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();

  const dailyStart = stripped.indexOf("===DAILY===");
  const memoriesStart = stripped.indexOf("===MEMORIES===");
  const endMarker = stripped.indexOf("===END===");

  if (dailyStart === -1) return { ok: false, daily: "", memories: [], error: "Missing ===DAILY=== marker" };
  if (memoriesStart === -1) return { ok: false, daily: "", memories: [], error: "Missing ===MEMORIES=== marker" };
  if (endMarker === -1) return { ok: false, daily: "", memories: [], error: "Missing ===END=== marker" };
  if (memoriesStart < dailyStart) return { ok: false, daily: "", memories: [], error: "===MEMORIES=== appears before ===DAILY===" };
  if (endMarker < memoriesStart) return { ok: false, daily: "", memories: [], error: "===END=== appears before ===MEMORIES===" };

  const daily = stripped.slice(dailyStart + "===DAILY===".length, memoriesStart).trim();
  if (!daily) return { ok: false, daily: "", memories: [], error: "Empty ===DAILY=== section" };

  const memoriesRaw = stripped.slice(memoriesStart + "===MEMORIES===".length, endMarker).trim();
  const memories: Array<{ type: MemoryType; content: string }> = [];
  if (memoriesRaw) {
    for (const line of memoriesRaw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^\[([a-z]+)\]\s+(.+)$/);
      if (!match) {
        warnings.push(`Malformed memory line (no [type] prefix): ${trimmed.slice(0, 80)}`);
        continue;
      }
      const [, type, content] = match;
      if (!VALID_TYPES.has(type!)) {
        warnings.push(`Unknown memory type '[${type}]' — skipping line`);
        continue;
      }
      memories.push({ type: type as MemoryType, content: content!.trim() });
    }
  }

  return { ok: true, daily, memories };
}

/** Default prompt location — ships inside the abmind package. */
function defaultPromptPath(): string {
  const hereDir = dirname(fileURLToPath(import.meta.url));
  // src/sleep/ → package root → prompts/sleep/basic.md
  return join(hereDir, "..", "..", "prompts", "sleep", "basic.md");
}

/** Log raw LLM output to $ABMIND_HOME/logs/sleep-basic-<ts>.log for forensics when parse fails. */
function logRawResponse(memoryDir: string, raw: string): void {
  try {
    const logsDir = join(memoryDir, "..", "logs");
    mkdirSync(logsDir, { recursive: true });
    const path = join(logsDir, `sleep-basic-${Date.now()}.log`);
    writeFileSync(path, raw);
    logWarn(TAG, `Raw LLM output written to ${path} for forensics`);
  } catch { /* best-effort */ }
}
