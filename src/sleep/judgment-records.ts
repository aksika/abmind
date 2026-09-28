/**
 * sleep/judgment-records.ts — bounded run-scoped advisory verdicts (#1817).
 *
 * Receipt annotation only covers candidates that reach `applyProposals`. Two
 * of the three advisory gates judge things that may never produce a receipt:
 * gc-noise runs outside the proposal seam on raw messages, and pre-triage
 * judges pairs the model may never propose. Those verdicts land here, in
 * file-based sleep state next to receipts — same privacy rules (identifiers
 * and short redacted excerpts, never raw prompts or file contents), same
 * no-`memory.db` boundary, its own bound so it cannot become a second
 * content store.
 *
 * Unlike `writeReceipts`, a persistence failure here never fails a step: an
 * advisory record is auxiliary data, and losing it must not break sleep. The
 * caller logs the loss and continues on the baseline path.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logWarn } from "../mem-logger.js";
import { redactSecrets } from "../redact-secrets.js";
import type { SleepVerdict } from "./receipts.js";

const TAG = "sleep-judgments";

/** Which advisory gate produced the verdict. */
export type JudgmentGate = "gc-noise" | "extract" | "pre-triage";

const GATES: ReadonlySet<string> = new Set(["gc-noise", "extract", "pre-triage"]);

const VERDICTS: ReadonlySet<string> = new Set(["supported", "disputed", "uncertain", "unjudged", "no-evidence"]);

export interface JudgmentRecordEntry {
  runId: string;
  step: string;
  principal: string;
  gate: JudgmentGate;
  /** Bounded subject descriptor: `msg:<id>` or `pair:<newId>-><oldId>`. */
  subject: string;
  /** Gate-specific machine decision (e.g. `noise`, `keep`, `triage=prune`). */
  decision: string;
  verdict: SleepVerdict;
  questionSet: string;
  model: string;
  /** Bounded machine-readable reason, not prose. */
  reason?: string;
  at: number;
}

/** Hard bound — the record is an audit trail, not a second content store. */
export const MAX_JUDGMENT_RECORDS_PER_RUN = 2000;
export const MAX_RECORD_SUBJECT_CHARS = 64;
export const MAX_RECORD_DECISION_CHARS = 64;
export const MAX_RECORD_REASON_CHARS = 200;

function sanitizeRunId(runId: string): string {
  const clean = runId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return clean || "unknown";
}

export function judgmentRecordPath(memoryDir: string, runId: string): string {
  return join(memoryDir, "sleep", "judgments", `judgments-${sanitizeRunId(runId)}.jsonl`);
}

function boundText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return redactSecrets(value).slice(0, max) || undefined;
}

/** Append advisory verdicts for one run. Never throws: persistence loss is
 *  reported to the caller as a count so the run record stays observable. */
export function writeJudgmentRecords(memoryDir: string, entries: readonly JudgmentRecordEntry[]): number {
  if (entries.length === 0) return 0;
  const capped = entries.slice(0, MAX_JUDGMENT_RECORDS_PER_RUN);
  const path = judgmentRecordPath(memoryDir, capped[0]?.runId ?? "unknown");
  try {
    mkdirSync(join(memoryDir, "sleep", "judgments"), { recursive: true });
  } catch (err) {
    // Directory creation failed — the verdicts are lost but sleep continues.
    logWarn(TAG, `judgment record dir failed (${path}): ${err instanceof Error ? err.message : String(err)}`);
    return entries.length;
  }
  const lines = capped.map((e) => JSON.stringify({
    runId: e.runId.slice(0, 128),
    step: e.step.slice(0, 64),
    principal: e.principal.slice(0, 128),
    gate: e.gate,
    subject: e.subject.slice(0, MAX_RECORD_SUBJECT_CHARS),
    decision: e.decision.slice(0, MAX_RECORD_DECISION_CHARS),
    verdict: e.verdict,
    questionSet: e.questionSet.slice(0, 64),
    model: e.model.slice(0, 64),
    ...(boundText(e.reason, MAX_RECORD_REASON_CHARS) !== undefined ? { reason: boundText(e.reason, MAX_RECORD_REASON_CHARS) } : {}),
    at: e.at,
  })).join("\n") + "\n";
  try {
    appendFileSync(path, lines, "utf-8");
  } catch (err) {
    logWarn(TAG, `judgment record persistence failed (${path}): ${err instanceof Error ? err.message : String(err)}`);
    return entries.length;
  }
  return 0;
}

function parseRecordLine(line: string): JudgmentRecordEntry | null {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e["runId"] !== "string" || typeof e["step"] !== "string") return null;
  if (typeof e["gate"] !== "string" || !GATES.has(e["gate"])) return null;
  if (typeof e["subject"] !== "string" || typeof e["decision"] !== "string") return null;
  if (typeof e["verdict"] !== "string" || !VERDICTS.has(e["verdict"])) return null;
  if (typeof e["questionSet"] !== "string" || typeof e["model"] !== "string") return null;
  if (typeof e["at"] !== "number" || !Number.isFinite(e["at"])) return null;
  return {
    runId: e["runId"],
    step: e["step"],
    principal: typeof e["principal"] === "string" ? e["principal"] : "",
    gate: e["gate"] as JudgmentGate,
    subject: e["subject"],
    decision: e["decision"],
    verdict: e["verdict"] as SleepVerdict,
    questionSet: e["questionSet"],
    model: e["model"],
    ...(typeof e["reason"] === "string" ? { reason: e["reason"] } : {}),
    at: e["at"],
  };
}

/** Read a run's advisory verdicts. Lenient like readReceipts: malformed
 *  lines are skipped, a missing file reads as empty. Never throws. */
export function readJudgmentRecords(memoryDir: string, runId: string): JudgmentRecordEntry[] {
  let raw: string;
  try {
    raw = readFileSync(judgmentRecordPath(memoryDir, runId), "utf-8");
  } catch { return []; }
  const out: JudgmentRecordEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseRecordLine(line);
    if (parsed) out.push(parsed);
    if (out.length >= MAX_JUDGMENT_RECORDS_PER_RUN) break;
  }
  return out;
}
