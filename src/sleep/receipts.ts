/**
 * sleep/receipts.ts — durable bounded write receipts (#1859).
 *
 * Every consequential sleep write decided by the candidate boundary leaves
 * one receipt per candidate/source: accepted, rejected, declined, or
 * dropped, with a bounded reason. Receipts live in file-based sleep state
 * (`<memoryDir>/sleep/receipts/receipts-<runId>.jsonl`) — never in
 * `memory.db` (no schema change). They carry identifiers and bounded
 * redacted excerpts only: never raw prompts, file contents, or secrets.
 *
 * A receipt is persisted before its input counts as handled: extraction
 * completeness and settlement treat a missing receipt like a missing
 * disposition. A failed receipt write fails the step, never the run
 * silently.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logWarn } from "../mem-logger.js";
import { redactSecrets } from "../redact-secrets.js";

const TAG = "sleep-receipts";

/** Dispositions. `dropped` is a valid abmind-side outcome (capacity/policy);
 *  `rejected` is a validation failure. Only accepted/declined/dropped count
 *  a source message as handled for settlement. */
export type ReceiptDisposition = "accepted" | "rejected" | "declined" | "dropped";

/**
 * #1817 — advisory sleep verdict. Additive and optional: settlement and
 * pruning read only `disposition`, never this field. `no-evidence` (nothing
 * to judge against) is distinct from `disputed` (evidence does not support
 * the claim). `unjudged` marks explicit fail-open, never validation.
 */
export type SleepVerdict = "supported" | "disputed" | "uncertain" | "unjudged" | "no-evidence";

const SLEEP_VERDICTS: ReadonlySet<string> = new Set(["supported", "disputed", "uncertain", "unjudged", "no-evidence"]);

export interface SleepJudgment {
  verdict: SleepVerdict;
  /** Question-set version that produced the verdict (e.g. sleep-support-v1). */
  questionSet: string;
  /** Judging model identity (provider model string). */
  model: string;
  /** Bounded machine-readable reason (e.g. per-dimension scores), not prose. */
  reason?: string;
}

export interface WriteReceipt {
  runId: string;
  step: string;
  principal: string;
  /** Stable operation identity: content-addressed from the proposal's
   *  verb, canonical args, and body (step-scoped). Resume reconciles
   *  an interrupted apply against this identity before retrying. */
  opId: string;
  op: string;
  disposition: ReceiptDisposition;
  /** Bounded human reason (≤200 chars, redacted). */
  reason?: string;
  /** Bounded redacted source evidence for declines/drops (≤200 chars). */
  evidence?: string;
  /** Source message this candidate settles, if any (extraction). */
  source?: number;
  memoryId?: number;
  knowledgeFile?: string;
  /** Resulting knowledge-file content hash (short) for reconcile. */
  knowledgeVersion?: string;
  /** #1817 advisory verdict. Never settles: existing consumers ignore it. */
  judgment?: SleepJudgment;
  at: number;
}

/** Hard bounds — receipts are audit markers, not a second content store. */
export const MAX_RECEIPT_REASON_CHARS = 200;
export const MAX_RECEIPT_EVIDENCE_CHARS = 200;
export const MAX_RECEIPTS_PER_RUN = 2000;

function sanitizeRunId(runId: string): string {
  const clean = runId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return clean || "unknown";
}

function firstRunId(receipts: readonly WriteReceipt[]): string {
  const first = receipts[0];
  return first ? first.runId : "unknown";
}

export function receiptPath(memoryDir: string, runId: string): string {
  return join(memoryDir, "sleep", "receipts", `receipts-${sanitizeRunId(runId)}.jsonl`);
}

function boundText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return redactSecrets(value).slice(0, max) || undefined;
}

/** Sanitize an advisory annotation to its bounds. Unknown verdicts drop the
 *  annotation, never the receipt — a bad verdict is advisory data loss. */
function boundJudgment(value: SleepJudgment | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!SLEEP_VERDICTS.has(value.verdict)) return undefined;
  const out: Record<string, unknown> = {
    verdict: value.verdict,
    questionSet: value.questionSet.slice(0, 64),
    model: value.model.slice(0, 64),
  };
  const reason = boundText(value.reason, MAX_RECEIPT_REASON_CHARS);
  if (reason !== undefined) out["reason"] = reason;
  return out;
}

function parseJudgment(raw: unknown): SleepJudgment | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const j = raw as Record<string, unknown>;
  if (typeof j["verdict"] !== "string" || !SLEEP_VERDICTS.has(j["verdict"])) return undefined;
  if (typeof j["questionSet"] !== "string" || typeof j["model"] !== "string") return undefined;
  const out: SleepJudgment = {
    verdict: j["verdict"] as SleepVerdict,
    questionSet: j["questionSet"].slice(0, 64),
    model: j["model"].slice(0, 64),
  };
  if (typeof j["reason"] === "string") out.reason = j["reason"].slice(0, MAX_RECEIPT_REASON_CHARS);
  return out;
}

/** Append receipts for one run. Throws on persistence failure — the caller
 *  must fail its step: an unrecorded write is an unhandled input. */
export function writeReceipts(memoryDir: string, receipts: readonly WriteReceipt[]): void {
  if (receipts.length === 0) return;
  if (receipts.length > MAX_RECEIPTS_PER_RUN) {
    throw new Error(`receipt batch exceeds ${MAX_RECEIPTS_PER_RUN} entries`);
  }
  const path = receiptPath(memoryDir, firstRunId(receipts));
  mkdirSync(join(memoryDir, "sleep", "receipts"), { recursive: true });
  const lines = receipts.map((r) => JSON.stringify({
    runId: r.runId.slice(0, 128),
    step: r.step.slice(0, 64),
    principal: r.principal.slice(0, 128),
    opId: r.opId.slice(0, 192),
    op: r.op.slice(0, 32),
    disposition: r.disposition,
    ...(boundText(r.reason, MAX_RECEIPT_REASON_CHARS) !== undefined ? { reason: boundText(r.reason, MAX_RECEIPT_REASON_CHARS) } : {}),
    ...(boundText(r.evidence, MAX_RECEIPT_EVIDENCE_CHARS) !== undefined ? { evidence: boundText(r.evidence, MAX_RECEIPT_EVIDENCE_CHARS) } : {}),
    ...(typeof r.source === "number" && Number.isSafeInteger(r.source) ? { source: r.source } : {}),
    ...(typeof r.memoryId === "number" && Number.isSafeInteger(r.memoryId) ? { memoryId: r.memoryId } : {}),
    ...(typeof r.knowledgeFile === "string" ? { knowledgeFile: r.knowledgeFile.slice(0, 64) } : {}),
    ...(typeof r.knowledgeVersion === "string" ? { knowledgeVersion: r.knowledgeVersion.slice(0, 32) } : {}),
    ...(boundJudgment(r.judgment) !== undefined ? { judgment: boundJudgment(r.judgment) } : {}),
    at: r.at,
  })).join("\n") + "\n";
  try {
    appendFileSync(path, lines, "utf-8");
  } catch (err) {
    logWarn(TAG, `receipt persistence failed (${path}): ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

function parseReceiptLine(line: string): WriteReceipt | null {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["runId"] !== "string" || typeof r["step"] !== "string"
    || typeof r["opId"] !== "string" || typeof r["op"] !== "string") return null;
  if (r["disposition"] !== "accepted" && r["disposition"] !== "rejected"
    && r["disposition"] !== "declined" && r["disposition"] !== "dropped") return null;
  if (typeof r["at"] !== "number" || !Number.isFinite(r["at"])) return null;
  const judgment = parseJudgment(r["judgment"]);
  return {
    runId: r["runId"],
    step: r["step"],
    principal: typeof r["principal"] === "string" ? r["principal"] : "",
    opId: r["opId"],
    op: r["op"],
    disposition: r["disposition"],
    ...(typeof r["reason"] === "string" ? { reason: r["reason"] } : {}),
    ...(typeof r["evidence"] === "string" ? { evidence: r["evidence"] } : {}),
    ...(typeof r["source"] === "number" ? { source: r["source"] } : {}),
    ...(typeof r["memoryId"] === "number" ? { memoryId: r["memoryId"] } : {}),
    ...(typeof r["knowledgeFile"] === "string" ? { knowledgeFile: r["knowledgeFile"] } : {}),
    ...(typeof r["knowledgeVersion"] === "string" ? { knowledgeVersion: r["knowledgeVersion"] } : {}),
    ...(judgment !== undefined ? { judgment } : {}),
    at: r["at"],
  };
}

/** Read a run's receipts. Lenient: malformed lines are skipped (they hold
 *  nothing), and a missing file reads as empty — absence is itself the
 *  signal settlement gates on. Never throws. */
export function readReceipts(memoryDir: string, runId: string): WriteReceipt[] {
  let raw: string;
  try {
    raw = readFileSync(receiptPath(memoryDir, runId), "utf-8");
  } catch { return []; }
  const out: WriteReceipt[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseReceiptLine(line);
    if (parsed) out.push(parsed);
    if (out.length >= MAX_RECEIPTS_PER_RUN) break;
  }
  return out;
}

/** Operation identities already accepted for one step — resume reconciles
 *  an interrupted apply against these before retrying. */
export function acceptedOpIds(receipts: readonly WriteReceipt[], step: string): Set<string> {
  const out = new Set<string>();
  for (const r of receipts) {
    if (r.step === step && r.disposition === "accepted") out.add(r.opId);
  }
  return out;
}
