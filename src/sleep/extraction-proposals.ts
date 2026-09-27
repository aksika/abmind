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

import type Database from "better-sqlite3";
import { logInfo, logWarn } from "../mem-logger.js";
import { redactSecrets } from "../redact-secrets.js";
import type { SleepDataAccess } from "../sleep-data-access.js";
import { applyProposals, emptySnapshot, loadAcceptedOpIds, persistProposalReceipts, MAX_PROPOSALS_PER_RESPONSE } from "./proposals.js";
import type { ProposalSnapshot } from "./proposals.js";
import { readReceipts } from "./receipts.js";
import type { WriteReceipt } from "./receipts.js";

const TAG = "extract-proposals";

/** Offered messages per batch and batches per run. Bounded so one sleep
 *  cycle cannot turn extraction into an unbounded crawl. */
export const EXTRACTION_BATCH_MESSAGES = 24;
export const MAX_EXTRACTION_BATCHES = 5;
export const MAX_OFFER_EXCERPT_CHARS = 300;

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

export interface ExtractionSummary {
  response: string;
  receipts: WriteReceipt[];
  /** Offered ids with no accepted/declined/dropped disposition. */
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
  step: string;
  principal: string;
  batch: readonly OfferedMessage[];
  response: string;
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
      alreadyAccepted: loadAcceptedOpIds(opts.memoryDir, opts.runId, opts.step),
    },
    opts.response,
  );
  persistProposalReceipts(opts.memoryDir, batchResult.receipts);

  const handled = new Set<number>();
  for (const rec of batchResult.receipts) {
    if (rec.op !== "store" && rec.op !== "decline") continue;
    if (rec.disposition !== "accepted" && rec.disposition !== "declined" && rec.disposition !== "dropped") continue;
    if (typeof rec.source === "number") handled.add(rec.source);
  }
  const unhandled = opts.batch.filter((m) => !handled.has(m.id)).map((m) => m.id);
  return { response: opts.response, receipts: batchResult.receipts, unhandled, budgetExhausted: false };
}

/** Extraction completeness over an entire run+step: every receipt that
 *  names a source settles it. Used by settlement/verification helpers. */
export function settledSources(memoryDir: string, runId: string, step: string): Set<number> {
  const out = new Set<number>();
  try {
    for (const r of readReceipts(memoryDir, runId)) {
      if (r.step !== step) continue;
      if (r.disposition !== "accepted" && r.disposition !== "declined" && r.disposition !== "dropped") continue;
      if (typeof r.source === "number") out.add(r.source);
    }
  } catch { /* absence is reported by callers as unhandled */ }
  return out;
}

export { MAX_PROPOSALS_PER_RESPONSE };
