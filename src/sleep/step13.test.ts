/**
 * step13.test.ts — final review parsing, verdict normalization, and footer
 * idempotency (#1912). Model-interaction flows are covered at the
 * orchestrator level; here the code-owned pieces stay pure.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseReviewResponse,
  normalizeVerdict,
  renderSleepReviewFooter,
  upsertSleepReviewFooter,
  stripSleepReviewFooter,
  buildReviewEvidence,
  REVIEW_STEP_NAME,
} from "./step13.js";
import type { SleepState } from "./state.js";
import type { StepRunScratch } from "./step-units.js";

const ORDER = ["gc-noise", "daily-summary", "retrospective", "extract-memories", "contradiction-and-graph", REVIEW_STEP_NAME];

function stateWith(steps: SleepState["steps"]): SleepState {
  return {
    status: "ongoing", pid: 1, startedAt: 0, llmCalls: 3,
    // failedEssentials counts absent essential steps as failed — default
    // the essential trio ok unless a case overrides them.
    steps: {
      "daily-summary": { status: "ok" },
      retrospective: { status: "ok" },
      "extract-memories": { status: "ok" },
      ...steps,
    },
  };
}

describe("parseReviewResponse", () => {
  it("parses findings, verb lines, artifact repairs, retry steps, and the advisory verdict", () => {
    const parsed = parseReviewResponse([
      "FINDING step=daily-summary issue=coverage detail=\"omitted range unrecorded\"",
      "FINDING step=nope issue=x detail=\"bad target\"",
      "DECLINE srcmsg=4 reason=\"chit-chat\"",
      "ARTIFACT_APPEND path=/d/daily.md base=abcdef123456",
      "appended retrospection",
      "END_ARTIFACT_APPEND",
      "RETRY_STEP step=extract-memories",
      "RETRY_STEP step=review-and-repair",
      "VERDICT: partial reason=\"needs more work\"",
    ].join("\n"), ORDER);
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0]).toMatchObject({ step: "daily-summary", invalidTarget: false });
    expect(parsed.findings[1]).toMatchObject({ step: "nope", invalidTarget: true });
    expect(parsed.verbLines).toEqual(["DECLINE srcmsg=4 reason=\"chit-chat\""]);
    expect(parsed.artifactRepairs).toEqual([{ path: "/d/daily.md", base: "abcdef123456", body: "appended retrospection" }]);
    expect(parsed.retrySteps).toEqual(["extract-memories", "review-and-repair"]);
    expect(parsed.proposedVerdict).toEqual({ verdict: "partial", reason: "needs more work" });
    expect(parsed.malformedVerdict).toBe(false);
  });

  it("flags malformed verdicts and ignores unterminated artifact blocks", () => {
    const parsed = parseReviewResponse("VERDICT: someday\nARTIFACT_APPEND path=/d base=xyz\nno end", ORDER);
    expect(parsed.malformedVerdict).toBe(true);
    expect(parsed.proposedVerdict).toBeNull();
    expect(parsed.artifactRepairs).toHaveLength(0);
  });

  it("never throws on hostile input", () => {
    expect(() => parseReviewResponse("FINDING step=\nVERDICT:\nARTIFACT_APPEND", ORDER)).not.toThrow();
  });
});

describe("normalizeVerdict", () => {
  const baseFor = (state: SleepState) => ({
    state, stepOrder: Object.keys(state.steps),
    validReview: true, writesMade: false, verifiedAfterWrite: false,
    repairsAccepted: 0, groundedDowngrade: null, failureDetails: [] as string[],
  });
  it("accepts a clean verified run, repaired-and-accepted with verified repairs", () => {
    const ok = stateWith({ "daily-summary": { status: "ok" } });
    expect(normalizeVerdict({ ...baseFor(ok) }).verdict).toBe("accepted");
    expect(normalizeVerdict({ ...baseFor(ok), writesMade: true, verifiedAfterWrite: true, repairsAccepted: 2 }).verdict).toBe("repaired_and_accepted");
  });

  it("missing review is unreviewed; unverified repairs stay unreviewed, never accepted", () => {
    const ok = stateWith({ "daily-summary": { status: "ok" } });
    expect(normalizeVerdict({ ...baseFor(ok), validReview: false }).verdict).toBe("unreviewed");
    expect(normalizeVerdict({ ...baseFor(ok), writesMade: true, verifiedAfterWrite: false, repairsAccepted: 1 }).verdict).toBe("unreviewed");
  });

  it("failed work caps at partial, concrete blockers at blocked", () => {
    const failed = stateWith({ "daily-summary": { status: "failed", failure: { cause: "invalid_response", detail: "x" } } });
    expect(normalizeVerdict({ ...baseFor(failed) }).verdict).toBe("partial");
    const blocked = stateWith({ "daily-summary": { status: "failed", failure: { cause: "provider_failed", failureClass: "permanent", detail: "no credits" } } });
    expect(normalizeVerdict({ ...baseFor(blocked) }).verdict).toBe("blocked");
  });

  it("undispatched steps are incomplete work — partial with resume notes, never success", () => {
    const partial = stateWith({ "daily-summary": { status: "ok" } });
    const { verdict, remainingIssues } = normalizeVerdict({ ...baseFor(partial), stepOrder: ORDER });
    expect(verdict).toBe("partial");
    expect(remainingIssues.join(" ")).toContain("preserved for resume");
  });

  it("a grounded model downgrade is honored; an ungrounded accepted claim never upgrades", () => {
    const failed = stateWith({ "daily-summary": { status: "failed", failure: { cause: "unknown" } } });
    expect(normalizeVerdict({ ...baseFor(failed), groundedDowngrade: "blocked" }).verdict).toBe("blocked");
    const ok = stateWith({ "daily-summary": { status: "ok" }, "gc-noise": { status: "ok" } });
    // accepted ceiling with an (ignored) accepted proposal stays accepted
    expect(normalizeVerdict({ ...baseFor(ok) }).verdict).toBe("accepted");
  });
});

describe("footer rendering and upsert", () => {
  it("renders from persisted facts and upserts idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "s13-"));
    try {
      const path = join(dir, "daily.md");
      writeFileSync(path, "# Daily\n\n- fact one with enough content to be usable here\n", "utf-8");
      const footer = renderSleepReviewFooter({
        verdict: "repaired_and_accepted", runId: "run12345678", snapshotId: "snap12345678", at: 1_000_000,
        repairsAccepted: 1, repairNotes: ["daily appended"], remainingIssues: [],
      });
      expect(footer).toContain("Verdict: repaired_and_accepted");
      expect(footer).toContain("run12345");
      expect(upsertSleepReviewFooter(path, footer, "run12345678")).toBe(path);
      const once = readFileSync(path, "utf-8");
      expect(once.split("## Sleep review")).toHaveLength(2);
      // Idempotent: same verdict upserts to identical bytes.
      expect(upsertSleepReviewFooter(path, footer, "run12345678")).toBe(path);
      expect(readFileSync(path, "utf-8")).toBe(once);
      // A newer verdict replaces, never duplicates.
      const footer2 = renderSleepReviewFooter({
        verdict: "accepted", runId: "run99999999", snapshotId: "snap99999999", at: 2_000_000,
        repairsAccepted: 0, repairNotes: [], remainingIssues: [],
      });
      upsertSleepReviewFooter(path, footer2, "run99999999");
      const twice = readFileSync(path, "utf-8");
      expect(twice.split("## Sleep review")).toHaveLength(2);
      expect(twice).toContain("Verdict: accepted");
      expect(stripSleepReviewFooter(twice)).toBe("# Daily\n\n- fact one with enough content to be usable here\n");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses a missing artifact path", () => {
    expect(upsertSleepReviewFooter("/nonexistent/daily.md", "## Sleep review\nx\n", "run1")).toBeNull();
  });
});

describe("buildReviewEvidence", () => {
  it("records unavailable artifacts explicitly and binds a snapshot id", () => {
    const dir = mkdtempSync(join(tmpdir(), "s13e-"));
    try {
      const scratch: StepRunScratch = {
        vars: {}, acceptedOutputChars: new Map(), dailySummaryPath: join(dir, "missing.md"),
        retrospectiveBeforeContent: null, skillReviewBeforeContent: null, gcValidIds: null,
        gcCycleSelection: null, newEvidenceRevisions: new Map(), existingEvidenceRevisions: new Map(),
        currentRunNewIds: new Set(), proposal: null, proposalReceipts: [], proposalByStep: new Map(),
        consolidation: null, soulPrefix: "",
      };
      const ev = buildReviewEvidence({
        state: stateWith({}), stepOrder: ORDER, memoryDir: dir,
        runId: "r1", priorRunId: null, level: "normal", scratch, now: () => 1,
      });
      expect(ev.dailyPath).toBeNull();
      expect(ev.text).toContain("unavailable");
      expect(ev.snapshotId).toHaveLength(12);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
