/**
 * Native sleep level — agent-produced JSON → memory DB.
 *
 * The kiro agent already has the conversation in its context window.
 * It writes a JSON file mapping directly to extracted_memories fields.
 * This module validates and commits it.
 */

import { readFileSync } from "node:fs";
import { logInfo, logWarn, logError } from "../mem-logger.js";
import { MemoryManager, getMemoryDb } from "../memory-manager.js";
import { CONSUMED_SESSION_SQL, coverageCeilingTs, scopeOfSession } from "./coverage.js";
import type { SleepState } from "./state.js";
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
  /** Coverage copied from `abmind expand --since-last-extraction` output. */
  coverage: {
    throughTs: number;
    messageCount: number;
    scopes: Array<"A" | "C">;
  };
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

  const rawCoverage = obj["coverage"];
  if (typeof rawCoverage !== "object" || rawCoverage === null || Array.isArray(rawCoverage)) {
    return { ok: false, error: "Missing or invalid 'coverage' object" };
  }
  const coverageRecord = rawCoverage as Record<string, unknown>;
  const throughTs = coverageRecord["throughTs"];
  if (typeof throughTs !== "number" || !Number.isFinite(throughTs) || throughTs < 0) {
    return { ok: false, error: "coverage.throughTs must be a finite non-negative timestamp" };
  }
  const messageCount = coverageRecord["messageCount"];
  if (typeof messageCount !== "number" || !Number.isSafeInteger(messageCount) || messageCount < 1) {
    return { ok: false, error: "coverage.messageCount must be a positive safe integer" };
  }
  const rawScopes = coverageRecord["scopes"];
  if (!Array.isArray(rawScopes) || rawScopes.length === 0 || rawScopes.some(scope => scope !== "A" && scope !== "C")) {
    return { ok: false, error: "coverage.scopes must contain A and/or C" };
  }
  const coverage = {
    throughTs,
    messageCount,
    scopes: [...new Set(rawScopes as Array<"A" | "C">)],
  };

  return { ok: true, payload: { daily: obj["daily"].trim(), memories, coverage } };
}

/** Apply an agent-produced JSON file to the memory DB. */
export async function runNativeApply(opts: {
  filePath: string;
  memoryConfig: MemoryConfig;
  dryRun: boolean;
}): Promise<NativeResult> {
  const warnings: string[] = [];

  // Captured before the read so nothing arriving during apply is marked
  // processed; the next cycle picks it up (#1603).
  const processedBoundaryTs = Date.now();

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

  if (opts.dryRun) {
    logInfo(TAG, `[dry-run] Would store ${payload.memories.length} memories + daily`);
    for (const m of payload.memories) logInfo(TAG, `  [${m.memory_type}] ${m.content_en.slice(0, 80)}`);
    return { ok: true, dailyPath: null, memoriesStored: 0, warnings };
  }

  // Native coverage metadata is checked against the exact pending range
  // before any daily, memory, or watermark write.
  const nowMs = Date.now();
  const memory = new MemoryManager(opts.memoryConfig);
  await memory.initialize({ skipEmbeddingCheck: true });
  // #1863: assert the run principal before any write and bind owner
  // provenance. The manager holds the owner snapshot; a non-master run
  // never reaches the write or the stores below.
  const sleepData = memory.getSleepData();
  const runUserId = sleepData.getPrimaryUserId();
  try {
    sleepData.assertWritePrincipal(runUserId);
  } catch (err) {
    const msg = `Native refused: run principal is not the primary owner (${err instanceof Error ? err.message : String(err)})`;
    logError(TAG, msg);
    memory.close();
    return { ok: false, dailyPath: null, memoriesStored: 0, warnings, error: msg };
  }

  const db = getMemoryDb(memory);
  if (!db) {
    memory.close();
    return { ok: false, dailyPath: null, memoriesStored: 0, warnings, error: "Native refused: memory database unavailable" };
  }
  const nativeCoverage = payload.coverage;
  const priorWatermark = sleepData.getExtractionWatermark(runUserId);
  if (nativeCoverage.throughTs > processedBoundaryTs || nativeCoverage.throughTs <= priorWatermark) {
    memory.close();
    return { ok: false, dailyPath: null, memoriesStored: 0, warnings, error: "Native refused: coverage timestamp is outside the pending message window" };
  }
  const coverageRows = db.prepare(
    `SELECT session_id, timestamp FROM messages
     WHERE user_id = ? AND timestamp > ? AND timestamp <= ?
       AND ${CONSUMED_SESSION_SQL} AND content NOT LIKE '[SYSTEM%'
     ORDER BY timestamp ASC, id ASC`,
  ).all(runUserId, priorWatermark, nativeCoverage.throughTs) as Array<{ session_id: string | null; timestamp: number }>;
  const excludedSystemRows = db.prepare(
    `SELECT timestamp FROM messages
     WHERE user_id = ? AND timestamp > ? AND timestamp <= ? AND content LIKE '[SYSTEM%'`,
  ).all(runUserId, priorWatermark, nativeCoverage.throughTs) as Array<{ timestamp: number }>;
  const actualScopes = [...new Set(coverageRows.map(row => scopeOfSession(row.session_id)))].sort();
  const claimedScopes = [...nativeCoverage.scopes].sort();
  const firstCoverageRow = coverageRows.at(0);
  const lastCoverageRow = coverageRows.at(-1);
  if (
    coverageRows.length !== nativeCoverage.messageCount
    || !firstCoverageRow
    || !lastCoverageRow
    || lastCoverageRow.timestamp !== nativeCoverage.throughTs
    || actualScopes.length !== claimedScopes.length
    || actualScopes.some((scope, index) => scope !== claimedScopes[index])
  ) {
    memory.close();
    return { ok: false, dailyPath: null, memoriesStored: 0, warnings, error: "Native refused: coverage does not match the pending messages in memory.db" };
  }
  const coveredState: SleepState = {
    status: "completed", pid: process.pid, startedAt: processedBoundaryTs, llmCalls: 0,
    steps: {
      "daily-summary": {
        status: "ok",
        claims: [
          ...actualScopes.map(scope => ({
            principal: runUserId,
            scope,
            startTs: priorWatermark + 1,
            endTs: nativeCoverage.throughTs,
            disposition: "covered" as const,
          })),
          ...excludedSystemRows.map(row => ({
            principal: runUserId,
            scope: "excluded" as const,
            startTs: row.timestamp,
            endTs: row.timestamp,
            disposition: "excluded" as const,
            reason: "system-prefix",
          })),
        ],
      },
    },
  };
  const coveredThroughTs = coverageCeilingTs(coveredState, runUserId, nativeCoverage.throughTs);
  if (coveredThroughTs === null) {
    memory.close();
    return { ok: false, dailyPath: null, memoriesStored: 0, warnings, error: "Native refused: coverage claims are incomplete" };
  }
  const coveredStartTs = firstCoverageRow.timestamp;
  const dailyPath = writeDailyFile(opts.memoryConfig.memoryDir, coveredStartTs, coveredThroughTs, payload.daily, nowMs, runUserId);
  logInfo(TAG, `Daily written: ${dailyPath}`);

  let memoriesStored = 0;
  try {
    for (const m of payload.memories) {
      const storeResult = await memory.editor.instantStore({
        userId: runUserId,
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
        const w = `Memory rejected (${m.memory_type}): ${storeResult.message}`;
        warnings.push(w);
        logWarn(TAG, w);
      }
    }
    sleepData.advanceExtractionWatermarks(coveredThroughTs, runUserId);
  } finally {
    memory.close();
  }

  logInfo(TAG, `🏁 Native: ${memoriesStored} memories stored, ${warnings.length} warnings`);

  return { ok: true, dailyPath, memoriesStored, warnings };
}
