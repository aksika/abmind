/**
 * sleep/completion-checks.ts — mechanical step completion checks (#1912).
 *
 * These are acceptance checks over durable evidence, not semantic judgment
 * (semantic quality belongs to step 13). After a step unit produces a
 * would-be-ok outcome, code verifies the required artifact, publication,
 * disposition, or directive evidence exists:
 *
 * - missing/invalid output with recoverable evidence → corrective input for
 *   another attempt inside the same work-item allowance;
 * - a failed prerequisite → an explicit dependency blocker, never a clean
 *   skip and never claimed success;
 * - legitimate no-change (valid empty selection, explicit no-op markers,
 *   nothing offered) → successful evaluation, not a demand to invent writes.
 *
 * A model's unsupported explanation is not proof of a justified blocker;
 * rejected/stale proposals never become claimed changes.
 */

import { hasAppendedDailyArtifact, readDailyArtifact } from "./sleep-extract-daily.js";
import type { ProposalSnapshot } from "./proposals.js";
import type { WriteReceipt } from "./receipts.js";
import type { StepRunScratch } from "./step-units.js";

export interface CompletionEvidence {
  stepName: string;
  response: string;
  /** Receipts applied for this invocation round (fenced steps). */
  receipts: WriteReceipt[];
  snapshot: ProposalSnapshot | null;
  scratch: StepRunScratch;
  /** Prerequisite disposition, e.g. daily-summary status for its dependents. */
  prerequisiteStatus?: string;
}

export type CompletionVerdict =
  | { status: "pass" }
  | { status: "correct"; detail: string; unresolved: number[] }
  | { status: "unresolved"; detail: string };

const VERB_RE = /^(PROPOSE_STORE|DECLINE|CONTRADICT|RELATION|PROMOTE|RETRO_INVALIDATE|TOPIC|MERGE_KEEP|EMOTION_CONTEXT|TRANSLATION_FIX|RELEVANCE|OBSERVE|KNOWLEDGE_ADD|KNOWLEDGE_REMOVE|KNOWLEDGE_UPDATE)\b/m;

/** Shown ids with no durable non-rejected disposition this round — bounded.
 *  Rejected/stale proposals never count as handled: the input remains open. */
function unhandledShownIds(snapshot: ProposalSnapshot | null, receipts: WriteReceipt[]): number[] {
  if (!snapshot || snapshot.shown.size === 0) return [];
  const handled = new Set<number>();
  for (const r of receipts) {
    if (r.disposition === "rejected") continue;
    if (typeof r.memoryId === "number") handled.add(r.memoryId);
    if (typeof r.source === "number") handled.add(r.source);
  }
  return [...snapshot.shown.keys()].filter(id => !handled.has(id)).slice(0, 10);
}

function correct(detail: string, snapshot: ProposalSnapshot | null, receipts: WriteReceipt[]): CompletionVerdict {
  return { status: "correct", detail, unresolved: unhandledShownIds(snapshot, receipts) };
}

/** Fenced format gate: verb directives, ASK lines, or explicit no-op
 *  markers — otherwise the model ignored its response contract. */
function checkFencedFormat(
  stepName: string,
  ev: CompletionEvidence,
  noOpMarkers: RegExp[],
  extraPass?: (ev: CompletionEvidence) => boolean,
): CompletionVerdict {
  // Any recorded receipt — accepted, declined, dropped, or rejected — proves
  // the response engaged the directive contract. Refused directives change
  // nothing and stay visible in receipts for step-13 semantic judgment;
  // retrying a deterministic refusal would be futile. Only output with no
  // directives and no explicit no-op earns corrective input.
  if (ev.receipts.length > 0) return { status: "pass" };
  if (extraPass?.(ev) === true) return { status: "pass" };
  if (ev.snapshot === null || (ev.snapshot.shown.size === 0 && ev.snapshot.pairs.size === 0)) {
    return { status: "pass" }; // nothing was offered — prose is a valid no-op
  }
  for (const re of noOpMarkers) {
    if (re.test(ev.response)) return { status: "pass" };
  }
  // Verb lines with zero receipts cannot happen through applyProposals
  // (malformed lines still record rejections) — defensive pass only.
  if (ev.receipts.length === 0 && VERB_RE.test(ev.response)) return { status: "pass" };
  return correct(
    `${stepName} applied nothing and stated no explicit no-op: respond with proposal directives, ASK lines where applicable, or an explicit no-change statement`,
    ev.snapshot,
    ev.receipts,
  );
}

/**
 * Mechanical completion check for a would-be-ok step outcome. Pure over
 * durable evidence and the invocation response — never calls the model.
 */
export function checkStepCompletion(ev: CompletionEvidence): CompletionVerdict {
  switch (ev.stepName) {
    case "gc-noise": {
      // Selection persistence is enforced by the finish hook; the check
      // asserts the persisted selection survived to disposition.
      if (ev.scratch.gcCycleSelection === null) {
        return { status: "unresolved", detail: "gc-noise has no persisted selection — internal invariant violated" };
      }
      return { status: "pass" };
    }
    case "daily-summary": {
      const path = ev.scratch.dailySummaryPath;
      if (!path || !readDailyArtifact(path).usable) {
        return correct("daily-summary bound no usable artifact: publish a readable owner/range-bound publication with covered and omitted ranges recorded", null, []);
      }
      return { status: "pass" };
    }
    case "retrospective": {
      // Confirmation prose alone is insufficient: prove the append to the
      // exact bound artifact while preserving earlier content. A tool-less
      // runtime cannot satisfy this — the outcome is then unresolved work
      // for step-13 repair, never success.
      const path = ev.scratch.dailySummaryPath;
      const before = ev.scratch.retrospectiveBeforeContent;
      if (!path || before === null || !hasAppendedDailyArtifact(path, before)) {
        return correct(
          `retrospective appended nothing to the bound daily artifact (${path ?? "unbound"}): append the retrospective covering events, emotional observations, lessons, and recurring errors while preserving earlier content — do not return prose alone`,
          null,
          [],
        );
      }
      return { status: "pass" };
    }
    case "extract-memories":
      // Disposition completeness is enforced by the shared boundary
      // (unhandled inputs return incomplete, never ok).
      return { status: "pass" };
    case "contradiction-and-graph":
      return checkFencedFormat(ev.stepName, ev,
        [/NO_CONTRADICTIONS/i, /NO_RELATIONS/i, /NO_QUESTIONS/i],
        (e) => /^\s*ASK\b/m.test(e.response));
    case "retro-derive":
      return checkFencedFormat(ev.stepName, ev,
        [/no promotions/i, /no knowledge changes/i, /\babsent\b/i]);
    case "feedback":
      return checkFencedFormat(ev.stepName, ev, [],
        (e) => /\d+\s+(boost|demote)/i.test(e.response));
    case "memory-maintenance":
      return checkFencedFormat(ev.stepName, ev,
        [/\(none\)/i, /no candidates/i],
        (e) => /\d+\s+(tagged|merged|kept|topics?|merges?|emotion)/i.test(e.response));
    case "translation":
      return checkFencedFormat(ev.stepName, ev,
        [/no (translation )?issues/i, /unchanged/i, /already correct/i, /fine as-is/i]);
    case "rem-synthesis":
      return checkFencedFormat(ev.stepName, ev,
        [/\b0\s+observations?\b/i, /no .*insights?/i, /nothing (non-obvious|useful|noteworthy)/i]);
    case "skill-review":
    case "consolidation":
      // Enforced by their finish hooks (append proof / publication binding).
      return { status: "pass" };
    default:
      return { status: "pass" };
  }
}

/**
 * Dependency prerequisite gate: missing inputs caused by a failed
 * prerequisite are blockers, not clean skips. A legitimately skipped or
 * absent prerequisite keeps the clean skip.
 */
export function checkPrerequisite(prerequisiteStatus: string | undefined, stepName: string): { status: "unresolved"; detail: string } | null {
  if (prerequisiteStatus === "failed" || prerequisiteStatus === "timeout") {
    return {
      status: "unresolved",
      detail: `${stepName} blocked: prerequisite daily-summary is ${prerequisiteStatus} — missing inputs are dependency blockers, not clean skips`,
    };
  }
  return null;
}
