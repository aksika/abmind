/**
 * Native sleep level — agent-produced JSON → memory DB.
 *
 * The kiro agent already has the conversation in its context window.
 * It writes a JSON file mapping directly to extracted_memories fields.
 * This module validates and commits it.
 */

import { readFileSync } from "node:fs";
import { logInfo, logWarn, logError } from "../mem-logger.js";
import { MemoryManager } from "../memory-manager.js";
import { writeDailyFile } from "./sleep-daily-summary.js";
import type { MemoryConfig } from "../memory-config.js";

const TAG = "sleep-native";

type MemoryType = "fact" | "decision" | "preference" | "event" | "lesson" | "feedback" | "story";

const VALID_TYPES = new Set<MemoryType>(["fact", "decision", "preference", "event", "lesson", "feedback", "story"]);

export interface NativeMemory {
  content_en: string;
  content_original?: string;
  memory_type: MemoryType;
}

export interface NativePayload {
  daily: string;
  memories: NativeMemory[];
}

export interface NativeResult {
  ok: boolean;
  dailyPath: string | null;
  memoriesStored: number;
  warnings: string[];
  error?: string;
}

/** Validate and parse the agent-produced JSON. Exported for tests. */
export function parseNativePayload(raw: string): { ok: true; payload: NativePayload } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "Expected a JSON object with 'daily' and 'memories' fields" };
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj["daily"] !== "string" || !obj["daily"].trim()) {
    return { ok: false, error: "Missing or empty 'daily' field" };
  }

  if (!Array.isArray(obj["memories"])) {
    return { ok: false, error: "Missing 'memories' array" };
  }

  const memories: NativeMemory[] = [];
  for (let i = 0; i < obj["memories"].length; i++) {
    const m = obj["memories"][i] as Record<string, unknown>;
    if (typeof m["content_en"] !== "string" || !m["content_en"].trim()) {
      return { ok: false, error: `memories[${i}]: missing or empty 'content_en'` };
    }
    if (typeof m["memory_type"] !== "string" || !VALID_TYPES.has(m["memory_type"] as MemoryType)) {
      return { ok: false, error: `memories[${i}]: invalid memory_type '${String(m["memory_type"])}' — expected: ${[...VALID_TYPES].join(", ")}` };
    }
    memories.push({
      content_en: m["content_en"].trim(),
      content_original: typeof m["content_original"] === "string" ? m["content_original"].trim() : undefined,
      memory_type: m["memory_type"] as MemoryType,
    });
  }

  return { ok: true, payload: { daily: obj["daily"].trim(), memories } };
}

/** Apply an agent-produced JSON file to the memory DB. */
export async function runNativeApply(opts: {
  filePath: string;
  memoryConfig: MemoryConfig;
  dryRun: boolean;
}): Promise<NativeResult> {
  const warnings: string[] = [];

  let raw: string;
  try {
    raw = readFileSync(opts.filePath, "utf-8");
  } catch (err) {
    const msg = `Failed to read ${opts.filePath}: ${err instanceof Error ? err.message : String(err)}`;
    logError(TAG, msg);
    return { ok: false, dailyPath: null, memoriesStored: 0, warnings, error: msg };
  }

  const result = parseNativePayload(raw);
  if (!result.ok) {
    logError(TAG, result.error);
    return { ok: false, dailyPath: null, memoriesStored: 0, warnings, error: result.error };
  }

  const { payload } = result;
  const today = new Date().toISOString().slice(0, 10);

  if (opts.dryRun) {
    logInfo(TAG, `[dry-run] Would store ${payload.memories.length} memories + daily for ${today}`);
    for (const m of payload.memories) logInfo(TAG, `  [${m.memory_type}] ${m.content_en.slice(0, 80)}`);
    return { ok: true, dailyPath: null, memoriesStored: 0, warnings };
  }

  const dailyPath = writeDailyFile(opts.memoryConfig.memoryDir, today, payload.daily);
  logInfo(TAG, `Daily written: ${dailyPath}`);

  const memory = new MemoryManager(opts.memoryConfig);
  await memory.initialize({ skipEmbeddingCheck: true });
  let memoriesStored = 0;
  try {
    for (const m of payload.memories) {
      const storeResult = await memory.editor.instantStore({
        userId: process.env["ABMIND_USER_ID"] ?? (() => { throw new Error("ABMIND_USER_ID env var required"); })(),
        contentEn: m.content_en,
        contentOriginal: m.content_original ?? m.content_en,
        memoryType: m.memory_type,
        emotionScore: 0,
        confidence: 3,
        createdBy: "sleep:native",
      });
      if (storeResult.stored) {
        memoriesStored += storeResult.memoriesCount;
      } else {
        const w = `Memory rejected (${m.memory_type}): ${storeResult.error ?? "unknown"}`;
        warnings.push(w);
        logWarn(TAG, w);
      }
    }
  } finally {
    memory.close();
  }

  logInfo(TAG, `🏁 Native: ${memoriesStored} memories stored, ${warnings.length} warnings`);

  // Advance extraction watermark so hook-wakeup knows extraction is done
  try {
    const { SleepDataAccess } = await import("../sleep-data-access.js");
    const sleepData = new SleepDataAccess(memory.getDb()!);
    sleepData.advanceExtractionWatermarks();
  } catch { /* non-fatal — watermark stays stale, next wakeup re-triggers */ }

  return { ok: true, dailyPath, memoriesStored, warnings };
}
