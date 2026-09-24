/**
 * ask-candidates.ts — #1515 step-05 clarification-candidate gate (#1838 Part 1).
 *
 * Verbatim move from src/sleep/orchestrator.ts (lines 1300-1430 @ 927deb7).
 * No logic touched.
 */

// ── #1515: step-05 clarification-candidate gate ─────────────────────────────
// Runs after #1653 downgrades, before terminal settlement. Pure deterministic
// validation over the retained step-05 response plus the exact evidence
// snapshots captured when the prompt was prepared. Only fully authorized
// candidates reach the question store (which enforces dedupe/caps under race).
// Exported for direct-input tests only — not part of the public contract.

import type Database from "better-sqlite3";
import { DreamQuestionStore } from "../dream-question-store.js";
import { redactSecrets } from "../redact-secrets.js";

export interface AskCandidateContext {
  /** Retained step-05 response (vars.CONTRADICTION_AND_GRAPH_OUTPUT). */
  response: string;
  questionStore: DreamQuestionStore;
  memDb: Database.Database;
  userId: string;
  runId: string;
  newEvidenceRevisions: ReadonlyMap<number, number>;
  existingEvidenceRevisions: ReadonlyMap<number, number>;
  currentRunNewIds: ReadonlySet<number>;
}

export interface ParsedAskCandidate {
  oldId: number;
  newId: number;
  question: string;
}

export const ASK_MAX_CANDIDATES_PER_RUN = 3;
export const ASK_QUESTION_MIN_CHARS = 20;
export const ASK_QUESTION_MAX_CHARS = 300;

const ASK_LINE_RE = /^ASK\s+old_id=(\d+)\s+new_id=(\d+)\s+question=(.+)$/;

/** Parse only exact anchored ASK lines in response order. Commentary and
 *  malformed lines are ignored; no template fallback ever invents a question. */
export function parseAskLines(response: string): ParsedAskCandidate[] {
  const candidates: ParsedAskCandidate[] = [];
  for (const rawLine of response.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("ASK")) continue;
    const m = ASK_LINE_RE.exec(line);
    if (!m) continue;
    const oldId = parseInt(m[1]!, 10);
    const newId = parseInt(m[2]!, 10);
    let question: unknown;
    try {
      question = JSON.parse(m[3]!);
    } catch {
      continue;
    }
    if (typeof question !== "string" || question.length === 0) continue;
    candidates.push({ oldId, newId, question });
  }
  return candidates;
}

/** Normalize to one trimmed line with repeated whitespace collapsed, then
 *  enforce the 20-300 char window and a literal `?`. Returns null when the
 *  candidate does not meet the deterministic shape. */
export function normalizeQuestion(raw: string): string | null {
  const oneLine = raw.replace(/\r\n/g, "\n").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  if (oneLine.length < ASK_QUESTION_MIN_CHARS || oneLine.length > ASK_QUESTION_MAX_CHARS) return null;
  if (!oneLine.includes("?")) return null;
  return oneLine;
}

/**
 * Evaluate the retained step-05 ASK lines in response order against the
 * deterministic gate and the current database truth, persisting at most three
 * accepted candidates per run. Returns the number of accepted rows.
 *
 * Role is validated BEFORE canonicalization: old_id must be an existing
 * evidence id and new_id a current-run new id. After authorization the pair is
 * canonicalized (memory_a_id = min, memory_b_id = max) and each revision is
 * mapped to its canonical id.
 */
export function processAskCandidates(ctx: AskCandidateContext): number {
  const candidates = parseAskLines(ctx.response);
  let accepted = 0;
  for (const candidate of candidates) {
    if (accepted >= ASK_MAX_CANDIDATES_PER_RUN) break;
    const { oldId, newId } = candidate;

    if (!Number.isSafeInteger(oldId) || !Number.isSafeInteger(newId)) continue;
    if (oldId < 1 || newId < 1 || oldId === newId) continue;
    const expectedNewRevision = ctx.newEvidenceRevisions.get(newId);
    const expectedOldRevision = ctx.existingEvidenceRevisions.get(oldId);
    if (expectedNewRevision === undefined || expectedOldRevision === undefined) continue;
    if (!ctx.currentRunNewIds.has(newId)) continue;

    const question = normalizeQuestion(candidate.question);
    if (question === null) continue;
    if (redactSecrets(question) !== question) continue;

    // One bounded statement over both current evidence rows, owner-scoped.
    const rows = ctx.memDb.prepare(
      `SELECT id, user_id, valid_to, classification, semantic_revision
       FROM extracted_memories WHERE id IN (?, ?) AND user_id = ?`,
    ).all(oldId, newId, ctx.userId) as Array<{
      id: number; user_id: string; valid_to: string | null; classification: number; semantic_revision: number;
    }>;
    const byId = new Map(rows.map(r => [r.id, r]));
    const oldRow = byId.get(oldId);
    const newRow = byId.get(newId);
    if (!oldRow || !newRow) continue;
    const rowOk = (r: { user_id: string; valid_to: string | null; classification: number; semantic_revision: number }, expectedRevision: number): boolean =>
      r.user_id === ctx.userId && r.valid_to === null && r.classification < 3 && r.semantic_revision === expectedRevision;
    if (!rowOk(oldRow, expectedOldRevision) || !rowOk(newRow, expectedNewRevision)) continue;

    // Canonicalize pair and map each revision to the canonical id.
    const memoryAId = Math.min(oldId, newId);
    const memoryBId = Math.max(oldId, newId);
    const revisionFor = (id: number): number | undefined => {
      const old = ctx.existingEvidenceRevisions.get(id);
      return old !== undefined ? old : ctx.newEvidenceRevisions.get(id);
    };
    const memoryARevision = revisionFor(memoryAId);
    const memoryBRevision = revisionFor(memoryBId);
    if (memoryARevision === undefined || memoryBRevision === undefined) continue;

    const result = ctx.questionStore.insertCandidate({
      userId: ctx.userId,
      memoryAId,
      memoryBId,
      memoryARevision,
      memoryBRevision,
      question,
      sourceRunId: ctx.runId,
    });
    if (result.accepted) accepted++;
  }
  return accepted;
}
