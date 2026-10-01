/**
 * shared-execution.ts — one execution boundary for sleep normal runs (#1884,
 * single recovery path since #1905).
 *
 * Daily-summary, extraction, and retrospective share one consequential
 * execution sequence here; step-units.ts keeps the normal route's scratch,
 * step-log, advisory, and failure-mapping policy.
 *
 * Scratch-free and lifecycle-free: shared functions never mutate run
 * scratch, never write step logs or evidence files, never write lifecycle
 * checkpoints, never unlink locks, never advance watermarks, and never emit
 * coordinator events. Durable execution writes stay inside (daily-file
 * publication, extraction applies, receipt persistence). Outcomes are
 * neutral — raw errors are classified but never normalized — so the normal
 * route keeps its existing terminal-vs-continue mapping, log policy,
 * and failure derivation.
 */

import type Database from "better-sqlite3";
import { buildDailySummary, writeDailyFile } from "../sleep-pipeline.js";
import type { DailySummaryResult } from "./sleep-daily-summary.js";
import type { SleepDataAccess } from "../sleep-data-access.js";
import {
  applyExtractionBatch,
  collectOfferedMessages,
  EXTRACTION_BATCH_MESSAGES,
  MAX_EXTRACTION_BATCHES,
  renderExtractionPrompt,
} from "./extraction-proposals.js";
import type { OfferedMessage } from "./extraction-proposals.js";
import type { AdvisoryJudge } from "./proposals.js";
import { hasAppendedDailyArtifact, readDailyArtifactRaw } from "./sleep-extract-daily.js";
import { isSleepModelFailure } from "./llm-budget.js";
import type { CoverageClaim } from "./coverage.js";

/** #1860: translate a daily-summary build into ledger claims scoped to the
 *  principal it read. Covered and skipped intervals carry their session
 *  scope; exclusions carry their reason. Moved verbatim from step-units.ts. */
export function claimsForDailySummary(userId: string, result: DailySummaryResult): CoverageClaim[] {
  return [
    ...result.covered.map(c => ({
      principal: userId, scope: c.scope, startTs: c.startTs, endTs: c.endTs,
      disposition: "covered" as const,
    })),
    ...result.skipped.map(s => ({
      principal: userId, scope: s.scope, startTs: s.startTs, endTs: s.endTs,
      disposition: "unclaimed" as const,
    })),
    ...result.excluded.map(e => ({
      principal: userId, scope: "excluded" as const, startTs: e.startTs, endTs: e.endTs,
      disposition: "excluded" as const, reason: e.reason,
    })),
  ];
}

// ── Daily summary ────────────────────────────────────────────────────────────

export interface SharedDailyInput {
  db: Database.Database;
  ctxWindow: number;
  memoryDir: string;
  userId: string;
  /** Normal supplies its watermark; the window always starts there. */
  window: { kind: "watermark"; watermarkTs: number };
  /** Coordinator-bound sender (runtime/step/run/deadline/budget wiring);
   *  null responses already converted to a thrown error as on both routes. */
  send: (prompt: string) => Promise<string>;
  /** Coordinator-bound principal assertion, run before publication. */
  assertPrincipal: (userId: string) => void;
}

/** Neutral outcome: model failures stay raw so coordinators keep their
 *  distinct terminal records; ordinary errors stay raw for route policies. */
export type SharedDailyOutcome =
  | { kind: "ok"; path: string; claims: CoverageClaim[]; summary: string }
  | { kind: "skipped" }
  | { kind: "modelFailure"; error: unknown }
  | { kind: "failed"; error: unknown };

export async function runSharedDailySummary(input: SharedDailyInput): Promise<SharedDailyOutcome> {
  const { db, ctxWindow, memoryDir, userId, window, send, assertPrincipal } = input;
  try {
    const result = await buildDailySummary(db, send, { ctxWindow, memoryDir, userId, watermarkTs: window.watermarkTs });
    if (!result) return { kind: "skipped" };
    // #1863: assert the run principal before the write; #1821: the filename
    // is the write instant, the build's window owns the heading.
    assertPrincipal(userId);
    const path = writeDailyFile(memoryDir, result.startTs, result.endTs, result.summary, Date.now(), userId, { covered: result.covered, skipped: result.skipped });
    return { kind: "ok", path, claims: claimsForDailySummary(userId, result), summary: result.summary };
  } catch (err) {
    return isSleepModelFailure(err) ? { kind: "modelFailure", error: err } : { kind: "failed", error: err };
  }
}

// ── Extraction ───────────────────────────────────────────────────────────────

export interface SharedExtractionInput {
  db: Database.Database;
  sleepData: SleepDataAccess;
  memoryDir: string;
  userId: string;
  /** Normal: watermark to captured ceiling. */
  windowStartTs: number;
  windowEndTs: number;
  /** Pre-read artifact content for the extraction prompt. */
  dailyContent: string;
  /** Dispatch and receipt identity, kept stable per route. */
  stepId: string;
  runId: string;
  priorRunId: string | null;
  /** Coordinator-bound proposal-only sender; null already converted as today. */
  send: (prompt: string) => Promise<string>;
  /** Normal-only advisory annotation, resolved lazily after the empty
   *  check so a skipped step initializes no judgment state; recovery
   *  never supplies it. */
  resolveAdvisoryJudge?: () => AdvisoryJudge | null;
}

export type SharedExtractionOutcome =
  | { kind: "ok"; settledCount: number; responses: string[] }
  | { kind: "skipped" }
  | { kind: "incomplete"; budgetExhausted: boolean; unhandled: number[]; offeredCount: number; responses: string[] }
  | { kind: "modelFailure"; error: unknown }
  | { kind: "failed"; error: unknown };

export async function runSharedExtraction(input: SharedExtractionInput): Promise<SharedExtractionOutcome> {
  const { db, sleepData, memoryDir, userId, windowStartTs, windowEndTs, dailyContent, stepId, runId, priorRunId, send, resolveAdvisoryJudge } = input;
  try {
    const offerCap = EXTRACTION_BATCH_MESSAGES * MAX_EXTRACTION_BATCHES;
    const allOffered = collectOfferedMessages(sleepData, userId, windowStartTs, windowEndTs);
    const budgetExhausted = allOffered.length > offerCap;
    const offered = budgetExhausted ? allOffered.slice(0, offerCap) : allOffered;
    if (offered.length === 0) return { kind: "skipped" };
    const advisoryJudge = resolveAdvisoryJudge?.() ?? undefined;
    const responses: string[] = [];
    const unhandled: number[] = [];
    for (let b = 0; b < Math.ceil(offered.length / EXTRACTION_BATCH_MESSAGES); b++) {
      const batch: OfferedMessage[] = offered.slice(b * EXTRACTION_BATCH_MESSAGES, (b + 1) * EXTRACTION_BATCH_MESSAGES);
      const prompt = renderExtractionPrompt(dailyContent, batch, b > 0);
      const response = await send(prompt);
      responses.push(response);
      const applied = await applyExtractionBatch({
        db,
        sleepData,
        memoryDir,
        runId,
        priorRunId,
        step: stepId,
        principal: userId,
        batch,
        response,
        ...(advisoryJudge !== undefined ? { advisoryJudge } : {}),
      });
      unhandled.push(...applied.unhandled);
    }
    if (budgetExhausted || unhandled.length > 0) {
      return { kind: "incomplete", budgetExhausted, unhandled, offeredCount: offered.length, responses };
    }
    return { kind: "ok", settledCount: offered.length, responses };
  } catch (err) {
    return isSleepModelFailure(err) ? { kind: "modelFailure", error: err } : { kind: "failed", error: err };
  }
}

// ── Retrospective ────────────────────────────────────────────────────────────
// Scope is retrospective only. skill-review stays normal-only with its
// stricter heading predicate; other prompt steps keep their owners.

export interface SharedRetrospectiveInput {
  /** Exact daily artifact, already validated readable by the coordinator. */
  dailyPath: string;
  /** Raw artifact bytes captured before dispatch. */
  beforeContent: string | null;
  /** Fully prepared prompt (normal consumes its SOUL prefix before this). */
  prompt: string;
  /** Coordinator-bound sender; null/abort/empty propagate for classification. */
  send: (prompt: string) => Promise<string | null>;
}

export type SharedRetrospectiveOutcome =
  | { kind: "okResponse"; response: string }
  /** `invalidResponse` carries the raw error: normal records bounded model
   *  evidence on this path before reporting ok, as the original catch did. */
  | { kind: "okArtifact"; source: "invalidResponse"; appendedChars: number; artifactPath: string; error: unknown }
  | { kind: "okArtifact"; source: "empty"; appendedChars: number; artifactPath: string }
  | { kind: "modelFailure"; error: unknown }
  | { kind: "failed"; error: unknown }
  | { kind: "noResponse"; empty: boolean };

/** #1752 R9 probe shared by both routes: empty/invalid prose succeeds only
 *  with an actual append relative to the pre-dispatch bytes. */
function appendedChars(dailyPath: string, before: string | null): number | null {
  if (before === null || !hasAppendedDailyArtifact(dailyPath, before)) return null;
  const current = readDailyArtifactRaw(dailyPath);
  return Math.max(1, (current?.length ?? 0) - before.length);
}

export async function runSharedRetrospective(input: SharedRetrospectiveInput): Promise<SharedRetrospectiveOutcome> {
  const { dailyPath, beforeContent, prompt, send } = input;
  let response: string | null;
  try {
    response = await send(prompt);
  } catch (err) {
    if (isSleepModelFailure(err)) {
      if (err.reason === "invalid_response") {
        const chars = appendedChars(dailyPath, beforeContent);
        if (chars !== null) return { kind: "okArtifact", source: "invalidResponse", appendedChars: chars, artifactPath: dailyPath, error: err };
      }
      return { kind: "modelFailure", error: err };
    }
    // Non-model errors keep their route-specific meaning: normal rethrows
    // them, recovery records an ordinary step failure. Never normalize here.
    return { kind: "failed", error: err };
  }
  if (response) return { kind: "okResponse", response };
  if (response === "") {
    const chars = appendedChars(dailyPath, beforeContent);
    if (chars !== null) return { kind: "okArtifact", source: "empty", appendedChars: chars, artifactPath: dailyPath };
    return { kind: "noResponse", empty: true };
  }
  return { kind: "noResponse", empty: false };
}
