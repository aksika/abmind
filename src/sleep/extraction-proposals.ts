/**
 * extraction-proposals.ts — proposal-based, disposition-complete extraction (#1859).
 *
 * The model no longer calls `abmind store`. Extraction receives bounded
 * batches of offered source messages (with their ids) alongside the
 * daily/retrospective artifact, and returns proposals only. Abmind applies
 * accepted candidates through the candidate boundary and records a durable
 * per-message disposition. A message that cannot be shown within the batch
 * budget stays unhandled, which makes extraction incomplete: the caller
 * fails the step, so settlement never advances past its input.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { atomicWriteSync } from "../atomic-write.js";
import { logInfo, logWarn } from "../mem-logger.js";
import { redactSecrets } from "../redact-secrets.js";
import type { SleepDataAccess } from "../sleep-data-access.js";
import {
  applyProposals,
  emptySnapshot,
  extractionProposalSourceId,
  loadAcceptedReceipts,
  persistProposalReceipts,
} from "./proposals.js";
import type { AdvisoryJudge, ProposalSnapshot } from "./proposals.js";
import type { WriteReceipt } from "./receipts.js";

const TAG = "extract-proposals";

/** Offered messages per batch and batches per run. Bounded so one sleep
 *  cycle cannot turn extraction into an unbounded crawl. */
export const EXTRACTION_BATCH_MESSAGES = 24;
export const MAX_EXTRACTION_BATCHES = 5;
export const MAX_OFFER_EXCERPT_CHARS = 300;
const MAX_FROZEN_PROPOSAL_BYTES = 64_000;

export interface OfferedMessage {
  id: number;
  role: string;
  content: string;
  ts: number;
}

/** Consumed-scope messages in (watermarkTs, coveredThroughTs], ordered by
 *  timestamp. `[SYSTEM` rows are never offered (they are an explicit
 *  content-based exclusion in #1860's ledger). */
export function collectOfferedMessages(
  sleepData: SleepDataAccess,
  principal: string,
  watermarkTs: number,
  coveredThroughTs: number,
): OfferedMessage[] {
  let rows: Array<{ id: number; role: string; content: string; emotion_score: number | null; timestamp: number }>;
  try {
    rows = sleepData.getMessagesAfter(watermarkTs, principal);
  } catch (err) {
    logWarn(TAG, `message read failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  const out: OfferedMessage[] = [];
  for (const r of rows) {
    if (r.content.startsWith("[SYSTEM")) continue;
    if (r.timestamp > coveredThroughTs) continue;
    out.push({ id: r.id, role: r.role, content: r.content, ts: r.timestamp });
    // One past the cap: the caller distinguishes "exactly at budget" from
    // "more messages exist than extraction can offer".
    if (out.length > EXTRACTION_BATCH_MESSAGES * MAX_EXTRACTION_BATCHES) break;
  }
  return out;
}

function offerSection(batch: readonly OfferedMessage[]): string {
  return batch
    .map((m) => `[src=${m.id}] [${m.role}] ${redactSecrets(m.content).slice(0, MAX_OFFER_EXCERPT_CHARS)}`)
    .join("\n");
}

const EXTRACTION_RULES = `You are working PROPOSAL-ONLY: no store/edit tools exist in this turn.
For every offered message id [src=N], answer with at least one of:
- PROPOSE_STORE srcmsg=N type=<fact|decision|preference|event|lesson> text="<one durable fact in English>"
  (repeat for each distinct durable fact; 1-3 per message is normal)
- DECLINE srcmsg=N reason="<why this message holds no durable memory>"
Do NOT store: agent output the user rejected, dismissed, or corrected; transient chatter.
Do not invent source ids. Do not output any other tool call.`;

/** Marker in the dispatch prompt that the test harness and the proposal
 *  flow share; it identifies the proposal grammar unambiguously. */
export const EXTRACTION_PROMPT_MARKER = "PROPOSAL-EXTRACTION-V1";

export function renderExtractionPrompt(dailyContent: string, batch: readonly OfferedMessage[], continuation: boolean): string {
  return `# ${EXTRACTION_PROMPT_MARKER} — Extract Memories

${continuation ? "Continuation batch — same rules as before." : "Here is today's conversation summary:"}
---
${dailyContent}
---

## Offered source messages (settle EVERY id)

${offerSection(batch)}

## Rules

${EXTRACTION_RULES}`;
}

interface FrozenExtractionDecision {
  version: 1;
  runId: string;
  sourceId: number;
  sourceTs: number;
  sourceFingerprint: string;
  response: string;
}

function ownerDecisionDir(memoryDir: string, principal: string): string {
  const ownerKey = createHash("sha256").update(principal, "utf-8").digest("hex").slice(0, 24);
  return join(memoryDir, "sleep", "extraction-decisions", ownerKey);
}

function sourceFingerprint(message: OfferedMessage): string {
  return createHash("sha256")
    .update(JSON.stringify([message.role, message.content, message.ts]), "utf-8")
    .digest("hex");
}

function decisionPath(memoryDir: string, principal: string, message: OfferedMessage): string {
  return join(ownerDecisionDir(memoryDir, principal), `${message.ts}-${message.id}-${sourceFingerprint(message)}.json`);
}

/** Remove frozen decisions only after settlement moved the owner's watermark
 *  past their source messages. */
export function pruneFrozenExtractionDecisions(memoryDir: string, principal: string, watermarkTs: number): void {
  const dir = ownerDecisionDir(memoryDir, principal);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const match = /^(\d+)-(\d+)-[a-f\d]{64}\.json$/i.exec(entry);
    if (!match) continue;
    const sourceTs = Number(match[1]);
    if (Number.isSafeInteger(sourceTs) && sourceTs <= watermarkTs) unlinkSync(join(dir, entry));
  }
}

function readFrozenDecision(memoryDir: string, principal: string, message: OfferedMessage): FrozenExtractionDecision | null {
  let raw: string;
  try {
    raw = readFileSync(decisionPath(memoryDir, principal, message), "utf-8");
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Frozen extraction decision for source ${message.id} is corrupt: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof value !== "object" || value === null) throw new Error(`Frozen extraction decision for source ${message.id} is invalid`);
  const record = value as Record<string, unknown>;
  const runId = record["runId"];
  const response = record["response"];
  if (record["version"] !== 1 || typeof runId !== "string" || runId.length === 0 || runId.length > 128
    || record["sourceId"] !== message.id || record["sourceTs"] !== message.ts
    || record["sourceFingerprint"] !== sourceFingerprint(message) || typeof response !== "string"
    || Buffer.byteLength(response, "utf-8") > MAX_FROZEN_PROPOSAL_BYTES
    || response.split("\n").some((line) => extractionProposalSourceId(line) !== message.id)) {
    throw new Error(`Frozen extraction decision for source ${message.id} failed validation`);
  }
  return {
    version: 1,
    runId,
    sourceId: message.id,
    sourceTs: message.ts,
    sourceFingerprint: sourceFingerprint(message),
    response,
  };
}

function partitionFrozenDecisions(response: string, batch: readonly OfferedMessage[]): Map<number, string> {
  const offeredIds = new Set(batch.map((message) => message.id));
  const linesBySource = new Map<number, string[]>();
  for (const rawLine of response.split(/\r?\n/)) {
    const line = rawLine.trim();
    const sourceId = extractionProposalSourceId(line);
    if (sourceId === null || !offeredIds.has(sourceId)) continue;
    const lines = linesBySource.get(sourceId) ?? [];
    lines.push(line);
    linesBySource.set(sourceId, lines);
  }
  return new Map([...linesBySource].map(([sourceId, lines]) => [sourceId, lines.join("\n")]));
}

function writeFrozenDecision(memoryDir: string, principal: string, message: OfferedMessage, runId: string, response: string): void {
  if (Buffer.byteLength(response, "utf-8") > MAX_FROZEN_PROPOSAL_BYTES) {
    throw new Error(`Frozen extraction decision for source ${message.id} exceeds ${MAX_FROZEN_PROPOSAL_BYTES} bytes`);
  }
  const dir = ownerDecisionDir(memoryDir, principal);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const decision: FrozenExtractionDecision = {
    version: 1,
    runId,
    sourceId: message.id,
    sourceTs: message.ts,
    sourceFingerprint: sourceFingerprint(message),
    response,
  };
  atomicWriteSync(decisionPath(memoryDir, principal, message), JSON.stringify(decision));
}

export interface ExtractionSummary {
  response: string;
  receipts: WriteReceipt[];
  /** Offered ids with a missing proposal or an unsettled proposal. */
  unhandled: number[];
  /** True when the batch budget could not offer every collected message. */
  budgetExhausted: boolean;
}

/** Apply one model response against one batch and honestly report which
 *  offered messages stayed unhandled. Persists receipts; a receipt
 *  persistence failure throws (the caller fails the step). */
export async function applyExtractionBatch(opts: {
  db: Database.Database;
  sleepData: SleepDataAccess;
  memoryDir: string;
  runId: string;
  /** The interrupted run that this attempt resumes, when any. */
  priorRunId?: string | null;
  /** Runs that originally froze a replayed decision, for receipt/advisory reconciliation. */
  additionalRunIds?: readonly string[];
  step: string;
  principal: string;
  batch: readonly OfferedMessage[];
  response: string;
  /** #1817 advisory hook — annotates store receipts, never diverts. */
  advisoryJudge?: AdvisoryJudge;
}): Promise<ExtractionSummary> {
  const snapshot: ProposalSnapshot = emptySnapshot(opts.runId, opts.step, opts.principal, ["store", "decline"]);
  for (const m of opts.batch) {
    snapshot.sources.set(m.id, redactSecrets(m.content).slice(0, 200));
  }
  const batchResult = await applyProposals(
    {
      db: opts.db,
      sleepData: opts.sleepData,
      memoryDir: opts.memoryDir,
      snapshot,
      alreadyAccepted: loadAcceptedReceipts(opts.memoryDir, [opts.runId, opts.priorRunId, ...(opts.additionalRunIds ?? [])], opts.step),
      ...(opts.advisoryJudge !== undefined ? { advisoryJudge: opts.advisoryJudge } : {}),
    },
    opts.response,
  );
  persistProposalReceipts(opts.memoryDir, batchResult.receipts);

  const expectedBySource = new Map<number, number>();
  const offeredIds = new Set(opts.batch.map((message) => message.id));
  for (const line of opts.response.split(/\r?\n/)) {
    const sourceId = extractionProposalSourceId(line);
    if (sourceId !== null && offeredIds.has(sourceId)) {
      expectedBySource.set(sourceId, (expectedBySource.get(sourceId) ?? 0) + 1);
    }
  }
  const settledBySource = new Map<number, number>();
  for (const rec of batchResult.receipts) {
    if (rec.op !== "store" && rec.op !== "decline") continue;
    if (rec.disposition !== "accepted" && rec.disposition !== "declined" && rec.disposition !== "dropped") continue;
    if (typeof rec.source === "number") settledBySource.set(rec.source, (settledBySource.get(rec.source) ?? 0) + 1);
  }
  const unhandled = opts.batch
    .filter((message) => {
      const expected = expectedBySource.get(message.id) ?? 0;
      return expected === 0 || settledBySource.get(message.id) !== expected;
    })
    .map((message) => message.id);
  return { response: opts.response, receipts: batchResult.receipts, unhandled, budgetExhausted: false };
}

/** Reuse exact per-source proposals across sleep runs. Persist every new
 *  decision before applying any proposal, so an interrupted apply replays the
 *  original set and never asks the model to restate already handled sources. */
export async function runExtractionBatch(opts: {
  db: Database.Database;
  sleepData: SleepDataAccess;
  memoryDir: string;
  runId: string;
  priorRunId: string | null;
  step: string;
  principal: string;
  dailyContent: string;
  batch: readonly OfferedMessage[];
  continuation: boolean;
  send: (prompt: string) => Promise<string>;
  advisoryJudge?: AdvisoryJudge;
}): Promise<{ responses: string[]; unhandled: number[] }> {
  const pending: OfferedMessage[] = [];
  const frozen: Array<{ message: OfferedMessage; runId: string; response: string }> = [];
  for (const message of opts.batch) {
    const decision = readFrozenDecision(opts.memoryDir, opts.principal, message);
    if (decision === null) pending.push(message);
    else frozen.push({ message, runId: decision.runId, response: decision.response });
  }

  const responses: string[] = [];
  const unhandled: number[] = [];
  if (pending.length > 0) {
    const response = await opts.send(renderExtractionPrompt(opts.dailyContent, pending, opts.continuation));
    responses.push(response);

    const decisions = partitionFrozenDecisions(response, pending);
    // Complete all durable writes before the first memory mutation. A crash
    // during this loop can only cause an un-applied source to be asked again.
    for (const message of pending) {
      const decision = decisions.get(message.id);
      if (decision !== undefined) writeFrozenDecision(opts.memoryDir, opts.principal, message, opts.runId, decision);
    }

    const applied = await applyExtractionBatch({
      db: opts.db,
      sleepData: opts.sleepData,
      memoryDir: opts.memoryDir,
      runId: opts.runId,
      priorRunId: opts.priorRunId,
      step: opts.step,
      principal: opts.principal,
      batch: pending,
      response,
      ...(opts.advisoryJudge !== undefined ? { advisoryJudge: opts.advisoryJudge } : {}),
    });
    unhandled.push(...applied.unhandled);
  }

  if (frozen.length > 0) {
    const response = frozen.map((entry) => entry.response).join("\n");
    responses.push(response);
    const applied = await applyExtractionBatch({
      db: opts.db,
      sleepData: opts.sleepData,
      memoryDir: opts.memoryDir,
      runId: opts.runId,
      priorRunId: opts.priorRunId,
      step: opts.step,
      principal: opts.principal,
      batch: frozen.map((entry) => entry.message),
      response,
      additionalRunIds: [...new Set(frozen.map((entry) => entry.runId))],
      ...(opts.advisoryJudge !== undefined ? { advisoryJudge: opts.advisoryJudge } : {}),
    });
    unhandled.push(...applied.unhandled);
  }

  return { responses, unhandled };
}
