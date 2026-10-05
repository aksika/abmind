/**
 * completion-checks.test.ts — mechanical step completion checks (#1912).
 *
 * Checks are pure over durable evidence: no model call, no fixtures beyond
 * small evidence objects. Semantic quality belongs to step 13, not here.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkStepCompletion, checkPrerequisite } from "./completion-checks.js";
import type { CompletionEvidence } from "./completion-checks.js";
import type { ProposalSnapshot } from "./proposals.js";
import type { StepRunScratch } from "./step-units.js";

function scratchWith(over: Partial<StepRunScratch> = {}): StepRunScratch {
  return {
    vars: {},
    acceptedOutputChars: new Map(),
    dailySummaryPath: null,
    retrospectiveBeforeContent: null,
    skillReviewBeforeContent: null,
    gcValidIds: null,
    gcCycleSelection: null,
    newEvidenceRevisions: new Map(),
    existingEvidenceRevisions: new Map(),
    currentRunNewIds: new Set(),
    proposal: null,
    proposalReceipts: [],
    proposalByStep: new Map(),
    consolidation: null,
    soulPrefix: "",
    ...over,
  };
}

function snapshotWith(shown: number[]): ProposalSnapshot {
  return {
    runId: "run", step: "s", principal: "master", eligible: [],
    shown: new Map(shown.map(id => [id, 1])),
    pairs: new Map(), currentRunNew: new Set(), sources: [],
    knowledge: new Map(), knowledgeUnavailable: new Map(),
  } as unknown as ProposalSnapshot;
}

function evWith(over: Partial<CompletionEvidence>): CompletionEvidence {
  return {
    stepName: "feedback", response: "ok", receipts: [],
    snapshot: null, scratch: scratchWith(), ...over,
  };
}

describe("checkStepCompletion", () => {
  it("passes valid no-work: nothing offered means prose is a valid no-op", () => {
    expect(checkStepCompletion(evWith({ stepName: "feedback", snapshot: snapshotWith([]) })).status).toBe("pass");
    expect(checkStepCompletion(evWith({ stepName: "memory-maintenance", snapshot: null })).status).toBe("pass");
  });

  it("rejects format-ignoring prose when work was offered — corrective with unresolved ids", () => {
    const verdict = checkStepCompletion(evWith({
      stepName: "feedback", response: "looks fine to me",
      snapshot: snapshotWith([7, 9]),
    }));
    expect(verdict.status).toBe("correct");
    if (verdict.status === "correct") expect(verdict.unresolved).toEqual([7, 9]);
  });

  it("accepts verb directives and explicit no-op markers", () => {
    expect(checkStepCompletion(evWith({
      stepName: "contradiction-and-graph", response: "NO_CONTRADICTIONS\nNO_RELATIONS\nNO_QUESTIONS\n",
      snapshot: snapshotWith([3]),
    })).status).toBe("pass");
    expect(checkStepCompletion(evWith({
      stepName: "feedback", response: "0 boosts and 0 demotes",
      snapshot: snapshotWith([3]),
    })).status).toBe("pass");
    expect(checkStepCompletion(evWith({
      stepName: "rem-synthesis", response: "0 observations proposed.",
      snapshot: snapshotWith([]),
    })).status).toBe("pass");
  });

  it("rejected receipts still engage the contract — recorded for step-13 judgment, not retried", () => {
    expect(checkStepCompletion(evWith({
      stepName: "translation", response: "TRANSLATION_FIX id=999 text=\"x\"",
      snapshot: snapshotWith([5]),
      receipts: [{ runId: "r", step: "translation", principal: "m", opId: "o", op: "translation_fix", disposition: "rejected", reason: "outside the shown set", at: 1 }],
    })).status).toBe("pass");
  });

  it("accepted receipts pass even when shown ids remain undispositioned", () => {
    expect(checkStepCompletion(evWith({
      stepName: "feedback", response: "RELEVANCE id=7 delta=+10 reason=\"useful\"",
      snapshot: snapshotWith([7, 9]),
      receipts: [{ runId: "r", step: "feedback", principal: "m", opId: "o", op: "relevance", disposition: "accepted", memoryId: 7, at: 1 }],
    })).status).toBe("pass");
  });

  it("retrospective prose without an append is corrective, never success", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-"));
    try {
      const path = join(dir, "daily.md");
      const before = "# Daily\n\n- fact one that is long enough to be usable content here\n";
      writeFileSync(path, before, "utf-8");
      const verdict = checkStepCompletion(evWith({
        stepName: "retrospective", response: "Today went well.",
        scratch: scratchWith({ dailySummaryPath: path, retrospectiveBeforeContent: before }),
      }));
      expect(verdict.status).toBe("correct");
      // An actual append with preserved prefix passes.
      writeFileSync(path, `${before}\n## Retrospective\nEvents, emotions, lessons, recurring errors.\n`, "utf-8");
      expect(checkStepCompletion(evWith({
        stepName: "retrospective", response: "Appended.",
        scratch: scratchWith({ dailySummaryPath: path, retrospectiveBeforeContent: before }),
      })).status).toBe("pass");
      // A rewrite (prefix destroyed) never passes.
      writeFileSync(path, "## Retrospective\nRewrote everything.\n", "utf-8");
      expect(checkStepCompletion(evWith({
        stepName: "retrospective", response: "Appended.",
        scratch: scratchWith({ dailySummaryPath: path, retrospectiveBeforeContent: before }),
      })).status).toBe("correct");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("daily-summary without a usable artifact is corrective", () => {
    expect(checkStepCompletion(evWith({
      stepName: "daily-summary", response: "done",
      scratch: scratchWith({ dailySummaryPath: null }),
    })).status).toBe("correct");
  });
});

describe("checkPrerequisite", () => {
  it("a failed prerequisite blocks explicitly — never a clean skip", () => {
    expect(checkPrerequisite("failed", "retrospective")).toMatchObject({ status: "unresolved" });
    expect(checkPrerequisite("timeout", "extract-memories")).toMatchObject({ status: "unresolved" });
  });

  it("skipped, missing, or ok prerequisites keep the existing skip/continue paths", () => {
    expect(checkPrerequisite("skipped", "retrospective")).toBeNull();
    expect(checkPrerequisite("missing", "retrospective")).toBeNull();
    expect(checkPrerequisite("ok", "retrospective")).toBeNull();
    expect(checkPrerequisite(undefined, "retrospective")).toBeNull();
  });
});
