/**
 * sleep/proposals.ts — bounded candidate proposal/apply seam (#1859).
 *
 * The model only proposes. Every consequential sleep write (memory stores,
 * edits, promotions, invalidations, knowledge-file changes) is applied from
 * an accepted bounded proposal validated against the invocation's candidate
 * snapshot: run/step/principal, shown candidate IDs with their displayed
 * semantic revisions, eligible old/new pair links, offered source messages,
 * and knowledge-file version hashes.
 *
 * Unknown identifiers, malformed proposals, stale snapshots, and pair
 * mismatches are rejected with reasons — never applied. Every candidate
 * leaves a durable receipt (accepted, rejected, declined, dropped) via
 * receipts.ts. Resume reconciles an interrupted apply against the
 * content-addressed operation identity before retrying.
 *
 * Proposal lines are anchored (ASK-style): illustrative prose is ignored,
 * lines starting with a known verb but failing to parse are rejected.
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { PrivateMemoryMutationStore } from "../private-memory-mutation-store.js";
import type { SleepDataAccess } from "../sleep-data-access.js";
import { localDate } from "../local-time.js";
import { logInfo, logWarn } from "../mem-logger.js";
import { atomicWriteSync } from "../atomic-write.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { upsertEdge } from "../entity-graph.js";
import type { WriteReceipt, ReceiptDisposition, SleepJudgment } from "./receipts.js";
import { writeReceipts, readReceipts } from "./receipts.js";

const TAG = "sleep-proposals";

/** Proposal verbs keyed by step eligibility. */
export type ProposalOp =
  | "store" | "decline"
  | "contradict" | "relation"
  | "promote" | "retro_invalidate"
  | "topic" | "merge_keep" | "emotion_context"
  | "translation_fix" | "relevance"
  | "observe"
  | "knowledge_add" | "knowledge_remove" | "knowledge_update"
  | "overflow";

/** Per-invocation bounded candidate snapshot. Built during step
 *  preparation from exactly what was rendered into the proposal prompt. */
export interface ProposalSnapshot {
  runId: string;
  step: string;
  principal: string;
  /** Shown memory id -> displayed semantic revision. */
  shown: Map<number, number>;
  /** Eligible invalidation pairs: new id -> shown old ids linked to it. */
  pairs: Map<number, Set<number>>;
  /** New-row eligibility (current-run extractions). */
  currentRunNew: Set<number>;
  /** Offered source messages: id -> bounded excerpt. */
  sources: Map<number, string>;
  /** Knowledge files readable at prepare: basename -> version. */
  knowledge: Map<string, { hash: string; size: number }>;
  /** Knowledge files explicitly unavailable at prepare. */
  knowledgeUnavailable: Map<string, "absent" | "unreadable">;
  /** Which verbs this invocation may use. */
  eligible: Set<ProposalOp>;
}

export function emptySnapshot(runId: string, step: string, principal: string, eligible: readonly ProposalOp[]): ProposalSnapshot {
  return {
    runId, step, principal,
    shown: new Map(), pairs: new Map(), currentRunNew: new Set(),
    sources: new Map(), knowledge: new Map(), knowledgeUnavailable: new Map(),
    eligible: new Set(eligible),
  };
}

// ── Bounds ──────────────────────────────────────────────────────────────────

export const MAX_PROPOSALS_PER_RESPONSE = 100;
export const MAX_OFFER_EXCERPT_CHARS = 300;
export const MAX_PROPOSE_TEXT_CHARS = 1000;
export const MAX_JSON_ARG_CHARS = 1000;
export const MAX_REASON_CHARS = 200;
export const MAX_ENTITY_NAME_CHARS = 80;
export const MAX_KNOWLEDGE_ENTRY_CHARS = 2000;
export const MAX_CORE_ENTRIES = 100;

export const STORE_TYPES: ReadonlySet<string> = new Set(["fact", "decision", "preference", "event", "lesson"]);
export const TOPIC_ALLOWLIST: ReadonlySet<string> = new Set(["coding", "personal", "work", "finance", "health", "projects", "tools", "people"]);
export const RELATION_ALLOWLIST: ReadonlySet<string> = new Set([
  "works_at", "lives_in", "friend_of", "part_of", "uses", "manages", "created", "depends_on", "member_of", "located_in",
]);
export const KNOWLEDGE_FILES: ReadonlySet<string> = new Set(["agent_notes.md", "user_profile.md", "core_facts.md"]);

/** Eligible verbs per fenced step. Steps outside this map are not fenced. */
export const STEP_PROPOSAL_OPS: Readonly<Record<string, readonly ProposalOp[]>> = {
  "extract-memories": ["store", "decline"],
  "contradiction-and-graph": ["contradict", "relation"],
  "retro-derive": ["promote", "retro_invalidate", "knowledge_add", "knowledge_remove", "knowledge_update"],
  "feedback": ["relevance"],
  "memory-maintenance": ["topic", "merge_keep", "emotion_context"],
  "translation": ["translation_fix"],
  "rem-synthesis": ["observe"],
};

/** Steps whose turns must run proposal-only (no state-changing tools). */
export function isProposalOnlyStep(stepId: string): boolean {
  return stepId in STEP_PROPOSAL_OPS;
}

// ── Snapshot helpers ────────────────────────────────────────────────────────

/** `#<id>` markers rendered into candidate lists. */
export function parseHashIds(text: string): number[] {
  const out: number[] = [];
  const re = /#(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1] ?? "", 10);
    if (Number.isSafeInteger(n) && n >= 1) out.push(n);
  }
  return out;
}

/** `[id=<id>]` markers rendered into evidence lists. */
export function parseBracketIds(text: string): number[] {
  const out: number[] = [];
  const re = /\[id=(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1] ?? "", 10);
    if (Number.isSafeInteger(n) && n >= 1) out.push(n);
  }
  return out;
}

/** Owner-scoped revision snapshot for shown ids: active, role-correct rows
 *  only. Rows that are sealed, invalid, or foreign never enter the snapshot,
 *  so naming them later rejects as unknown. */
export function snapshotRevisions(db: Database.Database, principal: string, ids: readonly number[]): Map<number, number> {
  const out = new Map<number, number>();
  const unique = [...new Set(ids)].filter((n) => Number.isSafeInteger(n) && n >= 1).slice(0, 500);
  if (unique.length === 0) return out;
  const placeholders = unique.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, semantic_revision FROM extracted_memories
     WHERE id IN (${placeholders}) AND user_id = ? AND valid_to IS NULL AND classification < 3`,
  ).all(...unique, principal) as Array<{ id: number; semantic_revision: number }>;
  for (const r of rows) out.set(r.id, r.semantic_revision);
  return out;
}

/** sha256 hex of exact file bytes; empty string when unreadable. */
export function hashKnowledgeBytes(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

export function readKnowledgeVersion(memoryDir: string, basename: string): { hash: string; size: number } | { unavailable: "absent" | "unreadable" } {
  if (!KNOWLEDGE_FILES.has(basename)) return { unavailable: "unreadable" };
  const path = join(memoryDir, "core", basename);
  try {
    const content = readFileSync(path, "utf-8");
    return { hash: hashKnowledgeBytes(content), size: Buffer.byteLength(content, "utf-8") };
  } catch (err) {
    const code = (err as { code?: string }).code;
    return { unavailable: code === "ENOENT" ? "absent" : "unreadable" };
  }
}

// ── Line parsing ────────────────────────────────────────────────────────────

const VERB_RE = /^(PROPOSE_STORE|DECLINE|CONTRADICT|RELATION|PROMOTE|RETRO_INVALIDATE|TOPIC|MERGE_KEEP|EMOTION_CONTEXT|TRANSLATION_FIX|RELEVANCE|OBSERVE|KNOWLEDGE_ADD|KNOWLEDGE_REMOVE|KNOWLEDGE_UPDATE)\b/;
const ARG_RE = /([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|\S+)/g;

function parseArgValue(raw: string): string | null {
  if (raw.startsWith('"')) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return null; }
    if (typeof parsed !== "string") return null;
    return parsed;
  }
  return raw;
}

interface ParsedLine {
  verb: string;
  args: Map<string, string>;
}

/** Parse one anchored proposal line. Returns the parsed form, the string
 *  "malformed" for a known verb that does not tile into key=value args, or
 *  null when the line is not a proposal line at all. */
function parseLine(line: string): ParsedLine | "malformed" | null {
  const verbMatch = VERB_RE.exec(line);
  if (!verbMatch) return null;
  const verb = verbMatch[1] ?? "";
  const rest = line.slice(verb.length).trim();
  if (rest.length === 0) return "malformed";
  const args = new Map<string, string>();
  ARG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = ARG_RE.exec(rest)) !== null) {
    // Args must tile the remainder without gaps — a gap means malformed.
    if (rest.slice(consumed, m.index).trim().length > 0) return "malformed";
    const value = parseArgValue(m[2] ?? "");
    if (value === null) return "malformed";
    args.set(m[1] ?? "", value);
    consumed = m.index + m[0].length;
  }
  if (rest.slice(consumed).trim().length > 0) return "malformed";
  if (args.size === 0) return "malformed";
  return { verb, args };
}

function parseIntArg(args: Map<string, string>, name: string): number | null {
  const raw = args.get(name);
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

function boundedArg(args: Map<string, string>, name: string, max: number, required: boolean): string | null | undefined {
  const raw = args.get(name);
  if (raw === undefined) return required ? null : undefined;
  if (raw.length === 0 || raw.length > max) return null;
  return raw;
}

/** Source id for a complete, bounded extraction decision line. Other proposal
 *  verbs and malformed/incomplete lines are not safe to freeze for retry. */
export function extractionProposalSourceId(line: string): number | null {
  const parsed = parseLine(line.trim());
  if (parsed === null || parsed === "malformed") return null;
  const sourceId = parseIntArg(parsed.args, "srcmsg");
  if (sourceId === null) return null;
  if (parsed.verb === "PROPOSE_STORE") {
    const type = parsed.args.get("type");
    const text = boundedArg(parsed.args, "text", MAX_PROPOSE_TEXT_CHARS, true);
    const original = boundedArg(parsed.args, "original", MAX_PROPOSE_TEXT_CHARS, false);
    if (type === undefined || !STORE_TYPES.has(type) || text === null || text === undefined || original === null) return null;
    return sourceId;
  }
  if (parsed.verb === "DECLINE") {
    const reason = boundedArg(parsed.args, "reason", MAX_REASON_CHARS, true);
    return reason === null || reason === undefined ? null : sourceId;
  }
  return null;
}

// ── Apply context ───────────────────────────────────────────────────────────

export interface ProposalApplyContext {
  db: Database.Database;
  sleepData: SleepDataAccess;
  memoryDir: string;
  snapshot: ProposalSnapshot;
  /** Accepted receipts keyed by opId, from this run and its lineage
   *  (priorRunId). A resumed run gets a new runId, so reconciliation must
   *  reach the interrupted run's accepted receipts. */
  alreadyAccepted: ReadonlyMap<string, WriteReceipt>;
  now?: () => number;
  /** #1817 advisory hook: judge one validated claim-carrying candidate.
   *  Returns an annotation to ride the receipt, or undefined to leave it
   *  unannotated. The hook never changes the disposition — applyProposals
   *  attaches its result and never branches on it. */
  advisoryJudge?: AdvisoryJudge;
}

/** One validated claim with its linked evidence for advisory judging. */
export interface AdvisorySubject {
  opId: string;
  claim: string;
  evidence: string[];
}

export type AdvisoryJudge = (subject: AdvisorySubject) => Promise<SleepJudgment | undefined>;

/** Ops whose proposals carry a judgeable claim (proposed text). Other ops
 *  name identifiers rather than claims and are left unannotated. */
const JUDGED_OPS: ReadonlySet<ProposalOp> = new Set(["store"]);

/** Build the advisory subject for a validated store candidate, or null when
 *  the candidate carries nothing to judge. Never rejects: validation already
 *  decided the disposition, and judging must not revisit it. */
function advisorySubjectFor(
  snapshot: ProposalSnapshot,
  op: ProposalOp,
  args: Map<string, string>,
  opId: string,
): AdvisorySubject | null {
  if (!JUDGED_OPS.has(op)) return null;
  const text = args.get("text");
  if (text === undefined) return null;
  const srcmsg = parseIntArg(args, "srcmsg");
  if (srcmsg === null) return null;
  const excerpt = snapshot.sources.get(srcmsg);
  if (excerpt === undefined) return null;
  return { opId, claim: text, evidence: [excerpt] };
}

interface ActiveRow {
  id: number;
  valid_to: string | null;
  classification: number;
  memory_type: string;
  semantic_revision: number;
}

function readActiveRow(db: Database.Database, principal: string, id: number): ActiveRow | undefined {
  return db.prepare(
    `SELECT id, valid_to, classification, memory_type, semantic_revision FROM extracted_memories
     WHERE id = ? AND user_id = ?`,
  ).get(id, principal) as ActiveRow | undefined;
}

function rowOk(row: ActiveRow | undefined, expectedRevision: number, forbidObservation: boolean): boolean {
  if (!row) return false;
  if (row.valid_to !== null || row.classification >= 3) return false;
  if (forbidObservation && row.memory_type === "observation") return false;
  return row.semantic_revision === expectedRevision;
}

function mutationCtx(snapshot: ProposalSnapshot, opId: string, step: string): { userId: string; actorId: string; operationKey: string; canDeclassifySecret: false; origin: "dreamy" } {
  return { userId: snapshot.principal, actorId: `sleep:${step}`, operationKey: opId, canDeclassifySecret: false, origin: "dreamy" };
}

/** #1859: content-addressed operation identity. The identity must survive a
 *  resume (a new runId) and response reordering, so it is derived from the
 *  proposal's own content — verb, canonical args, and block body — never
 *  from the run id or its index. A repeated identical proposal reconciles
 *  against the accepted receipt instead of applying twice. */
function opKeyFor(verb: string, args: Map<string, string> | null, body: string | null, rawLine: string): string {
  const canonical = args && args.size > 0
    ? [...args.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("\u0000")
    : rawLine;
  return createHash("sha256").update(`${verb}\u0001${canonical}\u0001${body ?? ""}`, "utf-8").digest("hex").slice(0, 16);
}

function receiptBase(snapshot: ProposalSnapshot, opId: string, op: ProposalOp, now: number): Omit<WriteReceipt, "disposition"> {
  return { runId: snapshot.runId, step: snapshot.step, principal: snapshot.principal, opId, op, at: now };
}

// ── Per-op application ──────────────────────────────────────────────────────

type ApplyResult = { disposition: ReceiptDisposition; reason?: string; evidence?: string; source?: number; memoryId?: number; knowledgeFile?: string; knowledgeVersion?: string };

async function applyParsed(
  ctx: ProposalApplyContext,
  op: ProposalOp,
  args: Map<string, string>,
  body: string | null,
  opId: string,
): Promise<ApplyResult> {
  const { db, sleepData, snapshot } = ctx;
  if (!snapshot.eligible.has(op)) {
    return { disposition: "rejected", reason: `verb not eligible for step ${snapshot.step}` };
  }
  const store = new PrivateMemoryMutationStore(db, sleepData.getOwnerSnapshot());

  switch (op) {
    case "store":
    case "observe": {
      const isObserve = op === "observe";
      const srcmsg = isObserve ? null : parseIntArg(args, "srcmsg");
      if (srcmsg === null && !isObserve) {
        return { disposition: "rejected", reason: "unknown or unshown source message" };
      }
      if (!isObserve && (srcmsg === null || !snapshot.sources.has(srcmsg))) {
        return { disposition: "rejected", reason: "unknown or unshown source message", ...(srcmsg !== null ? { source: srcmsg } : {}) };
      }
      const type = isObserve ? "observation" : args.get("type");
      if (!isObserve && (type === undefined || !STORE_TYPES.has(type))) {
        return { disposition: "rejected", reason: "unknown memory type", ...(srcmsg !== null ? { source: srcmsg } : {}) };
      }
      const memType = (isObserve ? "observation" : type) as "fact" | "decision" | "preference" | "event" | "lesson" | "observation";
      const text = boundedArg(args, "text", MAX_PROPOSE_TEXT_CHARS, true);
      if (text === null || text === undefined) return { disposition: "rejected", reason: "text missing or over budget", ...(srcmsg !== null ? { source: srcmsg } : {}) };
      const originalRaw = boundedArg(args, "original", MAX_PROPOSE_TEXT_CHARS, false);
      if (originalRaw === null) return { disposition: "rejected", reason: "original over budget", ...(srcmsg !== null ? { source: srcmsg } : {}) };
      const srcNum: number | null = srcmsg;
      const sourceIds = !isObserve && srcNum !== null ? String(srcNum) : undefined;
      const result = await store.appendInstant(
        mutationCtx(snapshot, opId, snapshot.step),
        {
          userId: snapshot.principal,
          contentEn: text,
          contentOriginal: originalRaw ?? text,
          memoryType: memType,
          emotionScore: 0,
          ...(sourceIds !== undefined ? { sourceMessageIds: sourceIds } : {}),
          ...(isObserve ? { trust: 2, credibility: 4 } : {}),
        },
      );
      if (!result.stored) {
        const msg = result.code === "unauthorized" ? "owner mismatch" : (result.message ?? result.code);
        return { disposition: "rejected", reason: `store refused: ${msg.slice(0, 120)}`, ...(srcmsg !== null ? { source: srcmsg } : {}) };
      }
      return { disposition: "accepted", ...(sourceIds !== undefined ? { source: parseInt(sourceIds, 10) } : {}), memoryId: result.memoryId };
    }

    case "decline": {
      const srcmsg = parseIntArg(args, "srcmsg");
      if (srcmsg === null || !snapshot.sources.has(srcmsg)) {
        return { disposition: "rejected", reason: "unknown or unshown source message", ...(srcmsg !== null ? { source: srcmsg } : {}) };
      }
      const reason = boundedArg(args, "reason", MAX_REASON_CHARS, true);
      if (reason === null || reason === undefined) return { disposition: "rejected", reason: "decline requires a bounded reason", source: srcmsg };
      return { disposition: "declined", reason, source: srcmsg, evidence: (snapshot.sources.get(srcmsg) ?? "").slice(0, 200) };
    }

    case "contradict":
    case "retro_invalidate":
    case "merge_keep": {
      // Pair-scoped invalidation: old/new must be shown, linked for this
      // invocation, current-run (contradict/retro) or mutually paired
      // (merge), active, role-correct, and at displayed revisions.
      let oldId: number | null;
      let newId: number | null;
      if (op === "merge_keep") {
        oldId = parseIntArg(args, "drop");
        newId = parseIntArg(args, "keep");
      } else {
        oldId = parseIntArg(args, "old_id");
        newId = parseIntArg(args, "new_id");
      }
      // Legacy CONTRADICT without new_id: the free-text invalidation path
      // stays closed — reject, never apply.
      if (oldId === null || newId === null || oldId === newId) {
        return { disposition: "rejected", reason: op === "contradict" && args.has("old_id") && !args.has("new_id")
          ? "CONTRADICT requires a shown old_id/new_id evidence pair"
          : "old/new identifiers missing or invalid" };
      }
      const reason = boundedArg(args, "reason", MAX_REASON_CHARS, true);
      if (reason === null || reason === undefined) return { disposition: "rejected", reason: "a bounded reason is required" };
      const expectedOld = snapshot.shown.get(oldId);
      const expectedNew = snapshot.shown.get(newId);
      if (expectedOld === undefined || expectedNew === undefined) {
        return { disposition: "rejected", reason: "identifier outside the shown candidate set" };
      }
      const linked = snapshot.pairs.get(newId);
      if (!linked || !linked.has(oldId)) {
        return { disposition: "rejected", reason: "old/new pair was not shown as linked evidence" };
      }
      // Contradiction names a current-run extraction as its new side.
      // RETRO_INVALIDATE's new side is a shown promotion candidate from the
      // retro warnings, so only CONTRADICT carries the current-run gate.
      if (op === "contradict" && !snapshot.currentRunNew.has(newId)) {
        return { disposition: "rejected", reason: "new row is not a current-run extraction" };
      }
      const oldTarget = oldId;
      const newTarget = newId;
      // Atomic decision: both displayed revisions are checked against
      // current rows under one transaction, and the target CAS still
      // controls the invalidation.
      const txn = db.transaction((): ApplyResult => {
        const oldRow = readActiveRow(db, snapshot.principal, oldTarget);
        const newRow = readActiveRow(db, snapshot.principal, newTarget);
        if (!rowOk(oldRow, expectedOld, true) || !rowOk(newRow, expectedNew, true)) {
          return { disposition: "rejected", reason: "evidence pair changed, invalid, or wrong owner" };
        }
        const applied = sleepData.invalidateMemory(snapshot.principal, oldTarget, expectedOld, localDate(new Date()), `sleep:${snapshot.step}`);
        if (!applied.ok) {
          return { disposition: "rejected", reason: `invalidation refused: ${applied.code}` };
        }
        return { disposition: "accepted", reason, memoryId: oldTarget };
      });
      try {
        return txn();
      } catch (err) {
        logWarn(TAG, `pair invalidation transaction failed: ${err instanceof Error ? err.message : String(err)}`);
        return { disposition: "rejected", reason: "invalidation transaction failed" };
      }
    }

    case "relation": {
      const source = parseIntArg(args, "source");
      if (source === null || !snapshot.currentRunNew.has(source) || !snapshot.shown.has(source)) {
        return { disposition: "rejected", reason: "relation source is not a shown current-run memory" };
      }
      const a = boundedArg(args, "entity_a", MAX_ENTITY_NAME_CHARS, true);
      const b = boundedArg(args, "entity_b", MAX_ENTITY_NAME_CHARS, true);
      const rel = args.get("rel");
      if (a === null || a === undefined || b === null || b === undefined) {
        return { disposition: "rejected", reason: "entity names missing or over budget" };
      }
      if (rel === undefined || !RELATION_ALLOWLIST.has(rel)) {
        return { disposition: "rejected", reason: "unknown relation type" };
      }
      try {
        upsertEdge(db, { userId: snapshot.principal, entity_a: a, entity_b: b, relation: rel, source_memory_id: source });
        return { disposition: "accepted" };
      } catch (err) {
        return { disposition: "rejected", reason: `edge refused: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}` };
      }
    }

    case "promote": {
      const id = parseIntArg(args, "id");
      const expected = id === null ? undefined : snapshot.shown.get(id);
      if (id === null || expected === undefined) {
        return { disposition: "rejected", reason: "identifier outside the shown candidate set" };
      }
      const reason = boundedArg(args, "reason", MAX_REASON_CHARS, true);
      if (reason === null || reason === undefined) return { disposition: "rejected", reason: "a bounded reason is required" };
      const row = readActiveRow(db, snapshot.principal, id);
      if (!rowOk(row, expected, false)) {
        return { disposition: "rejected", reason: "candidate changed, invalid, or wrong owner" };
      }
      const coreCount = (db.prepare(
        "SELECT COUNT(*) AS c FROM extracted_memories WHERE user_id = ? AND tier = 'core' AND valid_to IS NULL",
      ).get(snapshot.principal) as { c: number }).c;
      if (coreCount >= MAX_CORE_ENTRIES) {
        return { disposition: "dropped", reason: `core tier at capacity (${coreCount}/${MAX_CORE_ENTRIES})` };
      }
      const edited = store.edit(mutationCtx(snapshot, opId, snapshot.step),
        { userId: snapshot.principal, memoryId: id, expectedRevision: expected, tier: "core" });
      if (!edited.ok) return { disposition: "rejected", reason: `promotion refused: ${edited.code}` };
      return { disposition: "accepted", reason, memoryId: id };
    }

    case "topic": {
      const id = parseIntArg(args, "id");
      const expected = id === null ? undefined : snapshot.shown.get(id);
      if (id === null || expected === undefined) {
        return { disposition: "rejected", reason: "identifier outside the shown candidate set" };
      }
      const topic = args.get("topic");
      if (topic === undefined || !TOPIC_ALLOWLIST.has(topic)) {
        return { disposition: "rejected", reason: "unknown topic" };
      }
      const keywords = boundedArg(args, "keywords", MAX_JSON_ARG_CHARS, false);
      if (keywords === null) return { disposition: "rejected", reason: "keywords over budget" };
      const row = readActiveRow(db, snapshot.principal, id);
      if (!rowOk(row, expected, false)) {
        return { disposition: "rejected", reason: "candidate changed, invalid, or wrong owner" };
      }
      const edited = store.edit(mutationCtx(snapshot, opId, snapshot.step),
        { userId: snapshot.principal, memoryId: id, expectedRevision: expected, topic, ...(keywords !== undefined ? { keyword: keywords } : {}) });
      if (!edited.ok) return { disposition: "rejected", reason: `topic edit refused: ${edited.code}` };
      return { disposition: "accepted", memoryId: id };
    }

    case "emotion_context": {
      const id = parseIntArg(args, "id");
      const expected = id === null ? undefined : snapshot.shown.get(id);
      if (id === null || expected === undefined) {
        return { disposition: "rejected", reason: "identifier outside the shown candidate set" };
      }
      const text = boundedArg(args, "text", 120, true);
      if (text === null || text === undefined) return { disposition: "rejected", reason: "emotion context missing or over budget" };
      const row = readActiveRow(db, snapshot.principal, id);
      if (!rowOk(row, expected, false)) {
        return { disposition: "rejected", reason: "candidate changed, invalid, or wrong owner" };
      }
      const edited = store.edit(mutationCtx(snapshot, opId, snapshot.step),
        { userId: snapshot.principal, memoryId: id, expectedRevision: expected, emotionContext: text });
      if (!edited.ok) return { disposition: "rejected", reason: `emotion-context edit refused: ${edited.code}` };
      return { disposition: "accepted", memoryId: id };
    }

    case "translation_fix": {
      const id = parseIntArg(args, "id");
      const expected = id === null ? undefined : snapshot.shown.get(id);
      if (id === null || expected === undefined) {
        return { disposition: "rejected", reason: "identifier outside the shown candidate set" };
      }
      const text = boundedArg(args, "text", MAX_PROPOSE_TEXT_CHARS, true);
      if (text === null || text === undefined) return { disposition: "rejected", reason: "translation missing or over budget" };
      const row = readActiveRow(db, snapshot.principal, id);
      if (!rowOk(row, expected, false)) {
        return { disposition: "rejected", reason: "candidate changed, invalid, or wrong owner" };
      }
      const edited = store.edit(mutationCtx(snapshot, opId, snapshot.step),
        { userId: snapshot.principal, memoryId: id, expectedRevision: expected, contentEn: text });
      if (!edited.ok) return { disposition: "rejected", reason: `translation edit refused: ${edited.code}` };
      return { disposition: "accepted", memoryId: id };
    }

    case "relevance": {
      const id = parseIntArg(args, "id");
      const expected = id === null ? undefined : snapshot.shown.get(id);
      if (id === null || expected === undefined) {
        return { disposition: "rejected", reason: "identifier outside the shown candidate set" };
      }
      const deltaRaw = args.get("delta");
      const delta = deltaRaw === "+10" || deltaRaw === "10" ? 10 : deltaRaw === "-10" ? -10 : null;
      if (delta === null) return { disposition: "rejected", reason: "delta must be +10 or -10" };
      const row = readActiveRow(db, snapshot.principal, id);
      if (!rowOk(row, expected, false)) {
        return { disposition: "rejected", reason: "candidate changed, invalid, or wrong owner" };
      }
      const adjusted = store.adjustRelevance(mutationCtx(snapshot, opId, snapshot.step),
        { userId: snapshot.principal, memoryId: id, expectedRevision: expected, delta });
      if (!adjusted.ok) return { disposition: "rejected", reason: `relevance edit refused: ${adjusted.code}` };
      return { disposition: "accepted", memoryId: id };
    }

    case "knowledge_add":
    case "knowledge_remove":
    case "knowledge_update": {
      return applyKnowledgeOp(ctx, op, args, body, opId);
    }

    case "overflow": {
      return { disposition: "rejected", reason: "unreachable" };
    }
  }
}

// ── Knowledge-file ops ──────────────────────────────────────────────────────

function splitParagraphs(content: string): string[] {
  return content.split(/(\n[ \t]*\n)/g);
}

function applyKnowledgeOp(
  ctx: ProposalApplyContext,
  op: "knowledge_add" | "knowledge_remove" | "knowledge_update",
  args: Map<string, string>,
  body: string | null,
  opId: string,
): ApplyResult {
  const { memoryDir, snapshot } = ctx;
  const file = args.get("file");
  if (file === undefined || !KNOWLEDGE_FILES.has(file)) {
    return { disposition: "rejected", reason: "unknown knowledge file" };
  }
  const base = args.get("base");
  if (base === undefined || !/^[0-9a-f]{12}$/.test(base)) {
    return { disposition: "rejected", reason: "base must be the 12-char version shown for the file" };
  }
  const provenance = boundedArg(args, "provenance", MAX_REASON_CHARS, true);
  if (provenance === null || provenance === undefined) {
    return { disposition: "rejected", reason: "knowledge changes require bounded provenance" };
  }
  const unavailable = snapshot.knowledgeUnavailable.get(file);
  if (unavailable !== undefined) {
    return { disposition: "rejected", reason: unavailable === "absent" ? "file absent — no alternate path inferred" : "file unreadable — reported, not inferred" };
  }
  const shown = snapshot.knowledge.get(file);
  if (!shown) return { disposition: "rejected", reason: "file was not shown for this turn" };
  const path = join(memoryDir, "core", file);
  let current: string;
  try {
    current = readFileSync(path, "utf-8");
  } catch {
    return { disposition: "rejected", reason: "file became unreadable" };
  }
  // File CAS: the proposal applies only to the version shown to the model.
  const currentHash = hashKnowledgeBytes(current);
  if (!currentHash.startsWith(base) || shown.hash !== currentHash) {
    return { disposition: "rejected", reason: "stale file version — re-read before proposing" };
  }

  let next: string;
  if (op === "knowledge_add") {
    if (body === null || body.trim().length === 0 || body.length > MAX_KNOWLEDGE_ENTRY_CHARS) {
      return { disposition: "rejected", reason: "entry missing or over budget" };
    }
    next = current + (current.endsWith("\n") ? "\n" : "\n\n") + body.trim() + "\n";
  } else {
    const match = boundedArg(args, "match", MAX_REASON_CHARS, true);
    if (match === null || match === undefined) {
      return { disposition: "rejected", reason: "remove/update require a bounded match string" };
    }
    const parts = splitParagraphs(current);
    const hits: number[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      if ((parts[i] ?? "").includes(match)) hits.push(i);
    }
    if (hits.length === 0) return { disposition: "rejected", reason: "match string not found" };
    if (hits.length > 1) return { disposition: "rejected", reason: "match string is ambiguous" };
    const hit = hits[0] ?? 0;
    if (op === "knowledge_remove") {
      parts.splice(hit, 1);
      // Drop one adjacent separator to avoid leaving a blank gap.
      if ((parts[hit] ?? "").trim() === "") parts.splice(hit, 1);
      next = parts.join("");
    } else {
      if (body === null || body.trim().length === 0 || body.length > MAX_KNOWLEDGE_ENTRY_CHARS) {
        return { disposition: "rejected", reason: "replacement missing or over budget" };
      }
      parts[hit] = body.trim() + "\n";
      next = parts.join("");
    }
  }

  if (file === "agent_notes.md" && Buffer.byteLength(next, "utf-8") > 8 * 1024) {
    return { disposition: "rejected", reason: `resulting agent_notes.md over the 8 KiB budget (${Buffer.byteLength(next, "utf-8")} bytes)` };
  }
  try {
    atomicWriteSync(path, next);
  } catch {
    return { disposition: "rejected", reason: "atomic file replacement failed" };
  }
  const version = hashKnowledgeBytes(next).slice(0, 12);
  return { disposition: "accepted", reason: provenance, knowledgeFile: file, knowledgeVersion: version };
}

// ── Response processing ─────────────────────────────────────────────────────

export interface ProposalBatchResult {
  receipts: WriteReceipt[];
  /** Per-response overflow count (proposals beyond the budget). */
  overflowDropped: number;
}

/**
 * Parse and apply one model response against the invocation snapshot.
 * Accepted writes and receipts survive retry via the content-addressed
 * operation identity: entries already accepted for this step (this run or
 * its lineage) are reconciled with a receipt, never re-applied. Pure
 * function of (response, snapshot, db) plus receipt persistence — the
 * caller fails its step when persistence throws.
 */
export async function applyProposals(ctx: ProposalApplyContext, response: string): Promise<ProposalBatchResult> {
  const { snapshot } = ctx;
  const now = (ctx.now ?? Date.now)();
  const receipts: WriteReceipt[] = [];
  /** First outcome per opId within this response — a duplicate mirrors it
   *  instead of claiming an application that did not happen. */
  const seenResults = new Map<string, ApplyResult>();
  /** First advisory verdict per opId — a duplicate mirrors the annotation. */
  const seenJudgments = new Map<string, SleepJudgment>();
  let processed = 0;
  let overflowDropped = 0;

  const lines = response.split(/\r?\n/);
  let i = 0;
  const pushReceipt = (opId: string, op: ProposalOp, result: ApplyResult, judgment?: SleepJudgment): void => {
    receipts.push({
      ...receiptBase(snapshot, opId, op, now),
      disposition: result.disposition,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(result.evidence !== undefined ? { evidence: result.evidence } : {}),
      ...(result.source !== undefined ? { source: result.source } : {}),
      ...(result.memoryId !== undefined ? { memoryId: result.memoryId } : {}),
      ...(result.knowledgeFile !== undefined ? { knowledgeFile: result.knowledgeFile } : {}),
      ...(result.knowledgeVersion !== undefined ? { knowledgeVersion: result.knowledgeVersion } : {}),
      ...(judgment !== undefined ? { judgment } : {}),
    });
  };
  /** A reconciled proposal emits an accepted receipt carrying the prior
   *  write's identifiers so disposition-complete extraction still counts
   *  the source as handled. A prior advisory verdict rides along unchanged —
   *  resume reconciles annotations exactly like dispositions. */
  const pushReconciled = (opId: string, op: ProposalOp, prior: WriteReceipt | undefined, reason: string, judgmentOverride?: SleepJudgment, sourceId?: number): void => {
    const reconciledSource = prior?.source ?? sourceId;
    receipts.push({
      ...receiptBase(snapshot, opId, op, now),
      disposition: "accepted",
      reason,
      ...(reconciledSource !== undefined ? { source: reconciledSource } : {}),
      ...(prior?.memoryId !== undefined ? { memoryId: prior.memoryId } : {}),
      ...(prior?.knowledgeFile !== undefined ? { knowledgeFile: prior.knowledgeFile } : {}),
      ...(prior?.knowledgeVersion !== undefined ? { knowledgeVersion: prior.knowledgeVersion } : {}),
      ...(prior?.judgment !== undefined ? { judgment: prior.judgment } : {}),
      ...(judgmentOverride !== undefined ? { judgment: judgmentOverride } : {}),
    });
  };

  while (i < lines.length) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trim();
    i++;
    if (!VERB_RE.test(line)) continue;

    // Knowledge ops carry a body up to END_KNOWLEDGE.
    let body: string | null = null;
    const verbOnly = VERB_RE.exec(line)?.[1] ?? "";
    if (verbOnly === "KNOWLEDGE_ADD" || verbOnly === "KNOWLEDGE_UPDATE") {
      const collected: string[] = [];
      let terminated = false;
      while (i < lines.length) {
        const candidate = lines[i] ?? "";
        i++;
        if (candidate.trim() === "END_KNOWLEDGE") { terminated = true; break; }
        collected.push(candidate);
        if (collected.join("\n").length > MAX_KNOWLEDGE_ENTRY_CHARS + 100) break;
      }
      if (!terminated) {
        processed++;
        const opId = `${snapshot.step}/${opKeyFor(verbOnly, null, null, line)}`;
        pushReceipt(opId, verbOnly === "KNOWLEDGE_ADD" ? "knowledge_add" : "knowledge_update",
          { disposition: "rejected", reason: "unterminated knowledge block" });
        continue;
      }
      body = collected.join("\n");
    }

    const parsed = parseLine(line);
    const op = verbToOp(verbOnly);
    const args = parsed !== null && parsed !== "malformed" ? parsed.args : null;
    const sourceId = parsed !== null && parsed !== "malformed"
      && (op === "store" || op === "decline")
      ? parseIntArg(parsed.args, "srcmsg") ?? undefined
      : undefined;
    const opId = `${snapshot.step}/${opKeyFor(verbOnly, args, body, line)}`;
    const prior = ctx.alreadyAccepted.get(opId);
    if (prior !== undefined) {
      processed++;
      pushReconciled(opId, op ?? "decline", prior, "already applied in a prior attempt — reconciled, not re-applied", undefined, sourceId);
      logInfo(TAG, `reconciled already-applied ${opId} — skipping re-application`);
      continue;
    }
    if (seenResults.has(opId)) {
      processed++;
      const first = seenResults.get(opId)!;
      if (first.disposition === "accepted") {
        pushReconciled(opId, op ?? "decline", undefined, "duplicate proposal in this response — applied once", seenJudgments.get(opId), sourceId);
      } else {
        pushReceipt(opId, op ?? "decline", { ...first, reason: `${first.reason ?? first.disposition} (duplicate proposal in this response)` }, seenJudgments.get(opId));
      }
      continue;
    }
    processed++;
    if (processed > MAX_PROPOSALS_PER_RESPONSE) {
      overflowDropped++;
      continue;
    }

    if (parsed === null) continue; // unreachable: verb matched above
    if (parsed === "malformed" || op === null) {
      // A known verb that does not parse is malformed — rejected with a
      // reason, never silently ignored.
      pushReceipt(opId, op ?? "decline", { disposition: "rejected", reason: "malformed proposal line" });
      continue;
    }
    const result = await applyParsed(ctx, op, parsed.args, body, opId);
    seenResults.set(opId, result);
    const judgment = await judgeValidated(ctx, snapshot, op, parsed.args, opId, result);
    if (judgment !== undefined) seenJudgments.set(opId, judgment);
    pushReceipt(opId, op, result, judgment);
  }

  if (overflowDropped > 0) {
    receipts.push({
      ...receiptBase(snapshot, `${snapshot.step}/overflow`, "overflow", now),
      disposition: "dropped",
      reason: `${overflowDropped} proposal(s) beyond the ${MAX_PROPOSALS_PER_RESPONSE}-proposal budget were not applied`,
    });
  }
  return { receipts, overflowDropped };
}

/** #1817: judge one validated claim-carrying candidate for the receipt
 *  annotation. Runs after apply, attaches to the receipt, and never feeds
 *  back into the disposition — validation already decided it. A hook failure
 *  leaves the receipt unannotated rather than failing the step. */
async function judgeValidated(
  ctx: ProposalApplyContext,
  snapshot: ProposalSnapshot,
  op: ProposalOp,
  args: Map<string, string>,
  opId: string,
  result: ApplyResult,
): Promise<SleepJudgment | undefined> {
  if (ctx.advisoryJudge === undefined) return undefined;
  if (result.disposition === "rejected") return undefined;
  const subject = advisorySubjectFor(snapshot, op, args, opId);
  if (subject === null) return undefined;
  try {
    return await ctx.advisoryJudge(subject);
  } catch (err) {
    logWarn(TAG, `advisory judge failed for ${opId} (${err instanceof Error ? err.message : String(err)}) — receipt unannotated`);
    return undefined;
  }
}

function verbToOp(verb: string): ProposalOp | null {
  switch (verb) {
    case "PROPOSE_STORE": return "store";
    case "DECLINE": return "decline";
    case "CONTRADICT": return "contradict";
    case "RELATION": return "relation";
    case "PROMOTE": return "promote";
    case "RETRO_INVALIDATE": return "retro_invalidate";
    case "TOPIC": return "topic";
    case "MERGE_KEEP": return "merge_keep";
    case "EMOTION_CONTEXT": return "emotion_context";
    case "TRANSLATION_FIX": return "translation_fix";
    case "RELEVANCE": return "relevance";
    case "OBSERVE": return "observe";
    case "KNOWLEDGE_ADD": return "knowledge_add";
    case "KNOWLEDGE_REMOVE": return "knowledge_remove";
    case "KNOWLEDGE_UPDATE": return "knowledge_update";
    default: return null;
  }
}

/**
 * Accepted receipts for a step across a run lineage, keyed by opId. A
 * resumed run gets a new runId, so callers pass [currentRunId, priorRunId];
 * earlier (current) entries win. Never throws — an unreadable receipt file
 * reconciles to empty (re-application is then guarded by content-dedupe and
 * revision CAS).
 */
export function loadAcceptedReceipts(memoryDir: string, runIds: readonly (string | null | undefined)[], step: string): Map<string, WriteReceipt> {
  const out = new Map<string, WriteReceipt>();
  for (const runId of runIds) {
    if (!runId) continue;
    try {
      for (const receipt of readReceipts(memoryDir, runId)) {
        if (receipt.step !== step || receipt.disposition !== "accepted") continue;
        if (!out.has(receipt.opId)) out.set(receipt.opId, receipt);
      }
    } catch (err) {
      logWarn(TAG, `receipt reconcile read failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** Persist a batch. Throws on failure — the caller fails its step. */
export function persistProposalReceipts(memoryDir: string, receipts: readonly WriteReceipt[]): void {
  writeReceipts(memoryDir, receipts);
}
