/**
 * #1864 acceptance: consolidation cadence, range selection, and complete-or-fail
 * publication. Model turns are fixtured; the filesystem, checkpoint parsing,
 * due decisions, publisher, and the real sleep orchestrator stay real. Output
 * quality (criterion 6) is a bounded real-model evaluation, recorded with the
 * handoff — not proveable by fixtures.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { essentialSleepSteps, runSleepCycle } from "./orchestrator.js";
import { setupTestEnv, type TestEnv } from "./test-harness.js";
import type { SleepRunOptions } from "./contracts.js";
import {
  MAX_WEEKLY_GAP_WEEKS,
  addDays,
  dayOrdinal,
  decideQuarterlyDue,
  decideWeeklyDue,
  enumerateDays,
  isValidQuarterlyPeriod,
  isValidWeeklyPeriod,
  latestCompletedSunday,
  planConsolidation,
  quarterBounds,
  quarterOf,
  weekdayOf,
} from "./consolidation-cadence.js";
import type { CadenceCheckpoint } from "./consolidation-cadence.js";
import {
  CONSOLIDATION_COMPLETE_MARKER,
  parseConsolidationPeriod,
  parseConsolidationSources,
  publishConsolidationFile,
  validateConsolidationCompletion,
} from "./sleep-daily-summary.js";
import { getLatestConsolidationFile, searchConsolidationFiles } from "../consolidation-search.js";

const OWNER = "alice";
const COMPLETE_RESPONSE = `# Weekly — summary

## Events
- a decision was made

${CONSOLIDATION_COMPLETE_MARKER}
`;

function writeDailyFileFor(memoryDir: string, day: string, owner: string | null, text = "daily event"): string {
  const dir = join(memoryDir, "daily");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `daily_${day}-0000Z.md`);
  const ownerLine = owner === null ? "" : `Owner: ${owner}\n`;
  writeFileSync(path, `# Daily Summary ${day}\n${ownerLine}\n${text}\n`);
  return path;
}

function writeTrustedWeekly(
  memoryDir: string,
  period: { start: string; end: string },
  owner: string,
  sources: readonly string[],
  body = "# Weekly\n\ncontent under a heading",
): string {
  const dir = join(memoryDir, "weekly");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `weekly_${period.start}_${period.end}.md`);
  writeFileSync(
    path,
    `Owner: ${owner}\nPeriod-Start: ${period.start}\nPeriod-End: ${period.end}\nSources: ${sources.join(", ")}\nCovered: ${period.start} to ${period.end}\n\n${body}\n`,
  );
  return path;
}

function checkpointOf(period: { start: string; end: string }, sources: readonly string[] = []): CadenceCheckpoint {
  return { path: `/x/weekly_${period.start}_${period.end}.md`, period, sources };
}

function reportsText(plan: { reports: Array<{ level: string; message: string }> }): string {
  return plan.reports.map((r) => r.message).join("\n");
}

describe("#1864 cadence date arithmetic", () => {
  it("walks local days across DST transitions and year boundaries", () => {
    // US spring-forward (2026-03-08) and fall-back (2026-11-01); EU spring
    // (2026-03-29). Calendar construction, never fixed 86_400_000 offsets.
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(dayOrdinal("2026-03-09") - dayOrdinal("2026-03-07")).toBe(2);
    expect(enumerateDays("2026-03-07", "2026-03-10")).toEqual([
      "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10",
    ]);
  });

  it("computes the latest completed Sunday strictly before the run date", () => {
    expect(weekdayOf("2026-04-20")).toBe(1); // Monday
    expect(latestCompletedSunday("2026-04-20")).toBe("2026-04-19");
    expect(latestCompletedSunday("2026-04-19")).toBe("2026-04-12");
    expect(latestCompletedSunday("2026-04-22")).toBe("2026-04-19");
    expect(latestCompletedSunday("2026-01-01")).toBe("2025-12-28");
  });

  it("accepts Monday-start Sunday-end whole-week periods only", () => {
    expect(isValidWeeklyPeriod({ start: "2026-04-13", end: "2026-04-19" })).toBe(true);
    expect(isValidWeeklyPeriod({ start: "2026-03-23", end: "2026-04-19" })).toBe(true); // gap weekly
    expect(isValidWeeklyPeriod({ start: "2026-04-14", end: "2026-04-20" })).toBe(false); // Tuesday start
    expect(isValidWeeklyPeriod({ start: "2026-04-13", end: "2026-04-20" })).toBe(false); // 8 days
    expect(isValidWeeklyPeriod({ start: "2026-04-19", end: "2026-04-13" })).toBe(false);
  });

  it("accepts exactly a calendar quarter only", () => {
    expect(quarterBounds(2026, 1)).toEqual({ start: "2026-01-01", end: "2026-03-31" });
    expect(quarterBounds(2026, 4)).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(quarterOf("2026-07-01")).toEqual({ year: 2026, quarter: 3 });
    expect(isValidQuarterlyPeriod({ start: "2026-04-01", end: "2026-06-30" })).toBe(true);
    expect(isValidQuarterlyPeriod({ start: "2026-04-01", end: "2026-06-29" })).toBe(false);
    expect(isValidQuarterlyPeriod({ start: "2026-04-02", end: "2026-06-30" })).toBe(false);
  });
});

describe("#1864 weekly due decisions", () => {
  it("no trustworthy checkpoint: due for the most recent completed week, reported as cutover", () => {
    const due = decideWeeklyDue([], "2026-04-20");
    expect(due.due).toBe(true);
    expect(due.cutover).toBe(true);
    expect(due.period).toEqual({ start: "2026-04-13", end: "2026-04-19" });
  });

  it("a checkpoint at the latest completed Sunday is not due again", () => {
    const trusted = [checkpointOf({ start: "2026-04-13", end: "2026-04-19" })];
    const due = decideWeeklyDue(trusted, "2026-04-20");
    expect(due.due).toBe(false);
    expect(decideWeeklyDue(trusted, "2026-04-26").due).toBe(false);
  });

  it("a cutover range works across a year boundary", () => {
    const due = decideWeeklyDue([], "2026-01-05");
    expect(due.due).toBe(true);
    expect(due.cutover).toBe(true);
    expect(due.period).toEqual({ start: "2025-12-29", end: "2026-01-04" });
  });

  it("a gap range works across a daylight saving change", () => {
    // 2026-03-29 is the Sunday the local clocks spring forward.
    const trusted = [checkpointOf({ start: "2026-03-23", end: "2026-03-29" })];
    const due = decideWeeklyDue(trusted, "2026-04-06");
    expect(due.due).toBe(true);
    expect(due.period).toEqual({ start: "2026-03-30", end: "2026-04-05" });
    expect(due.capped).toBe(false);
  });

  it("a gap range starts the day after the checkpoint and never overlaps it", () => {
    const trusted = [checkpointOf({ start: "2026-03-23", end: "2026-03-29" })];
    const due = decideWeeklyDue(trusted, "2026-04-20");
    expect(due.due).toBe(true);
    expect(due.cutover).toBe(false);
    expect(due.period).toEqual({ start: "2026-03-30", end: "2026-04-19" });
    expect(due.capped).toBe(false);
  });

  it("caps a long gap at the oldest MAX_WEEKLY_GAP_WEEKS slice; the next run advances", () => {
    const trusted = [checkpointOf({ start: "2025-12-29", end: "2026-01-04" })];
    const due = decideWeeklyDue(trusted, "2026-04-20");
    expect(due.capped).toBe(true);
    expect(due.period).toEqual({ start: "2026-01-05", end: "2026-03-01" });
    expect((dayOrdinal(due.period.end) - dayOrdinal(due.period.start) + 1) / 7).toBe(MAX_WEEKLY_GAP_WEEKS);
    const advanced = decideWeeklyDue([...trusted, checkpointOf(due.period)], "2026-04-20");
    expect(advanced.due).toBe(true);
    expect(advanced.period).toEqual({ start: "2026-03-02", end: "2026-04-19" });
    expect(advanced.capped).toBe(false);
  });
});

describe("#1864 quarterly due decisions", () => {
  it("no trustworthy checkpoint: the most recently completed quarter is due", () => {
    const due = decideQuarterlyDue([], "2026-07-01");
    expect(due.due).toBe(true);
    expect(due.period).toEqual({ start: "2026-04-01", end: "2026-06-30" });
  });

  it("stays due until the quarter is complete, and missed quarters publish oldest-first", () => {
    const q2 = checkpointOf({ start: "2026-04-01", end: "2026-06-30" });
    expect(decideQuarterlyDue([q2], "2026-07-01").due).toBe(false);
    // A missed quarter behind the checkpoint stays the due range across runs.
    const q1 = checkpointOf({ start: "2026-01-01", end: "2026-03-31" });
    const missed = decideQuarterlyDue([q1], "2026-07-01");
    expect(missed.due).toBe(true);
    expect(missed.period).toEqual({ start: "2026-04-01", end: "2026-06-30" });
  });
});

describe("#1864 plan: checkpoints, selection, late sources", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cons-1864-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores legacy/foreign/invalid artifacts as checkpoints and reports them in counts", () => {
    const legacy = join(dir, "weekly", "weekly_2026-04-13.md");
    mkdirSync(join(dir, "weekly"), { recursive: true });
    writeFileSync(legacy, "# Weekly\n\nlegacy writer-date file with no period header\n");
    writeTrustedWeekly(dir, { start: "2026-04-06", end: "2026-04-12" }, "other-user", [], "# Weekly\n\nforeign");
    writeDailyFileFor(dir, "2026-04-13", OWNER);
    const plan = planConsolidation(dir, "2026-04-20", OWNER);
    expect(plan.target?.tier).toBe("weekly");
    expect(plan.target?.period).toEqual({ start: "2026-04-13", end: "2026-04-19" });
    expect(reportsText(plan)).toContain("weekly/:");
    expect(reportsText(plan)).toContain("foreign-owner");
    expect(reportsText(plan)).toContain("cutover");
  });

  it("fails closed when the bounded checkpoint header scan cannot find a trusted candidate", () => {
    const weeklyDir = join(dir, "weekly");
    mkdirSync(weeklyDir, { recursive: true });
    for (let index = 0; index <= MAX_WEEKLY_GAP_WEEKS; index++) {
      const end = addDays("2026-04-12", -index * 7);
      const start = addDays(end, -6);
      writeFileSync(join(weeklyDir, `weekly_${start}_${end}.md`), "# invalid legacy body\n");
    }

    const plan = planConsolidation(dir, "2026-04-20", OWNER);
    expect(plan.target).toBeNull();
    expect(plan.skipReason).toContain("checkpoint scan incomplete");
    expect(reportsText(plan)).toContain("bounded header limit");
  });

  it("selects each due date's newest owner-verified cover and reports missing dates", () => {
    for (const day of ["2026-04-13", "2026-04-14", "2026-04-15", "2026-04-17", "2026-04-18", "2026-04-19"]) {
      writeDailyFileFor(dir, day, OWNER);
    }
    writeDailyFileFor(dir, "2026-04-16", "someone-else");
    const plan = planConsolidation(dir, "2026-04-20", OWNER);
    expect(plan.target?.missingDates).toEqual(["2026-04-16"]);
    expect(plan.target?.sourcePaths).toHaveLength(6);
    expect(plan.target?.outputPath).toBe(join(dir, "weekly", "weekly_2026-04-13_2026-04-19.md"));
    expect(reportsText(plan)).toContain("unattributed or mismatched provenance");
  });

  it("carries a late daily exactly once, gated on prior Sources membership", () => {
    const week1Sources = ["2026-04-06", "2026-04-07", "2026-04-08", "2026-04-09", "2026-04-10", "2026-04-12"]
      .map((day) => writeDailyFileFor(dir, day, OWNER));
    const w1 = writeTrustedWeekly(dir, { start: "2026-04-06", end: "2026-04-12" }, OWNER, week1Sources);
    void w1;
    // Late daily inside the already-summarized week, absent from its Sources.
    const lateDaily = writeDailyFileFor(dir, "2026-04-11", OWNER, "late arrival");
    for (const day of ["2026-04-13", "2026-04-14", "2026-04-15", "2026-04-16", "2026-04-17", "2026-04-18", "2026-04-19"]) {
      writeDailyFileFor(dir, day, OWNER);
    }
    const first = planConsolidation(dir, "2026-04-20", OWNER);
    expect(first.target?.listSection).toContain(lateDaily);
    expect(first.target?.sourcePaths.filter((p) => p === lateDaily)).toHaveLength(1);
    expect(first.target?.listSection).toContain("late source");

    for (const day of ["2026-04-20", "2026-04-21", "2026-04-22", "2026-04-23", "2026-04-24", "2026-04-25", "2026-04-26"]) {
      writeDailyFileFor(dir, day, OWNER);
    }
    // Publish the prepared target; its Sources now list the late daily, so the
    // next period's plan must not carry it again.
    publishConsolidationFile(dir, COMPLETE_RESPONSE, {
      owner: OWNER,
      tier: "weekly",
      period: first.target!.period,
      coveredRange: first.target!.coveredRange,
      sourcePaths: first.target!.sourcePaths,
    });
    const next = planConsolidation(dir, "2026-04-27", OWNER);
    expect(next.target?.period).toEqual({ start: "2026-04-20", end: "2026-04-26" });
    expect(next.target?.sourcePaths).not.toContain(lateDaily);
    expect(next.target?.listSection).not.toContain(lateDaily);
  });

  it("reports late dailies outside the bounded lookback instead of backfilling them", () => {
    const oldSources = ["2025-12-29", "2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02", "2026-01-03"]
      .map((day) => writeDailyFileFor(dir, day, OWNER));
    writeTrustedWeekly(dir, { start: "2025-12-29", end: "2026-01-04" }, OWNER, oldSources);
    const ancientLate = writeDailyFileFor(dir, "2026-01-04", OWNER, "late, but out of window");
    writeDailyFileFor(dir, "2026-01-05", OWNER); // makes the capped oldest-first range publishable
    const plan = planConsolidation(dir, "2026-04-27", OWNER);
    expect(plan.target?.period).toEqual({ start: "2026-01-05", end: "2026-03-01" });
    expect(plan.target?.listSection).not.toContain(ancientLate);
    expect(reportsText(plan)).toContain("lookback were reported, not backfilled");
  });

  it("quarterly prefers in-quarter weeklies and resolves only unrepresented dates to dailies", () => {
    const week1Sources = ["2026-06-01", "2026-06-03"].map((day) => writeDailyFileFor(dir, day, OWNER));
    writeTrustedWeekly(dir, { start: "2026-06-01", end: "2026-06-07" }, OWNER, week1Sources);
    expect(week1Sources).toHaveLength(2);
    // A daily arriving after the weekly was published fills an unrepresented
    // date in the due quarter instead of being hidden by the weekly period.
    const lateDaily = writeDailyFileFor(dir, "2026-06-02", OWNER, "late arrival");
    // Latest completed week already summarized → the weekly lane is not due.
    writeTrustedWeekly(dir, { start: "2026-06-22", end: "2026-06-28" }, OWNER, []);
    // A legacy writer-date weekly in the quarter is never promoted.
    const legacy = join(dir, "weekly", "weekly_2026-06-01.md");
    writeFileSync(legacy, "# Weekly\n\nlegacy overlapping window\n");
    writeDailyFileFor(dir, "2026-06-04", OWNER);
    writeDailyFileFor(dir, "2026-06-08", OWNER);
    const plan = planConsolidation(dir, "2026-07-01", OWNER);
    expect(plan.target?.tier).toBe("quarterly");
    expect(plan.target?.outputPath).toBe(join(dir, "quarterly", "quarterly_2026-Q2.md"));
    expect(plan.target?.listSection).toContain("weekly summary");
    expect(plan.target?.sourcePaths).toContain(join(dir, "weekly", "weekly_2026-06-01_2026-06-07.md"));
    expect(plan.target?.sourcePaths).toContain(join(dir, "weekly", "weekly_2026-06-22_2026-06-28.md"));
    expect(plan.target?.sourcePaths).toContain(lateDaily);
    expect(plan.target?.sourcePaths).toContain(join(dir, "daily", "daily_2026-06-08-0000Z.md"));
    expect(plan.target?.sourcePaths).not.toContain(legacy);
    // The two daily sources bound by the first weekly are represented; its
    // missing dates and the source-less later weekly period remain unknown.
    expect(plan.target?.listSection).not.toContain("2026-06-01:");
    expect(plan.target?.listSection).not.toContain("2026-06-03:");
    expect(plan.target?.missingDates).toHaveLength(86); // 91 days - 2 weekly sources - 3 resolved dailies
  });

  it("keeps weekly and quarterly independent: a due weekly publishes while the quarter stays due", () => {
    writeTrustedWeekly(dir, { start: "2026-04-06", end: "2026-04-12" }, OWNER, []);
    for (const day of ["2026-04-13", "2026-04-14", "2026-04-15", "2026-04-16", "2026-04-17", "2026-04-18", "2026-04-19"]) {
      writeDailyFileFor(dir, day, OWNER);
    }
    const plan = planConsolidation(dir, "2026-04-20", OWNER);
    expect(plan.target?.tier).toBe("weekly");
    expect(reportsText(plan)).toContain("remains due");
  });

  it("a due weekly with no sources does not block a due quarterly in the same run", () => {
    // Due week 2026-06-22..28 has no dailies; the due Q2 quarter must still
    // get its target from the unrepresented Q2 daily.
    writeDailyFileFor(dir, "2026-04-05", OWNER);
    const plan = planConsolidation(dir, "2026-07-01", OWNER);
    expect(plan.target?.tier).toBe("quarterly");
    expect(plan.target?.period).toEqual({ start: "2026-04-01", end: "2026-06-30" });
    expect(plan.target?.sourcePaths).toEqual([join(dir, "daily", "daily_2026-04-05-0000Z.md")]);
    expect(reportsText(plan)).toContain("quarterly due is evaluated independently");
  });

  it("selects a cutover week spanning the year boundary", () => {
    for (const day of ["2025-12-29", "2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]) {
      writeDailyFileFor(dir, day, OWNER);
    }
    const plan = planConsolidation(dir, "2026-01-05", OWNER);
    expect(plan.target?.tier).toBe("weekly");
    expect(plan.target?.period).toEqual({ start: "2025-12-29", end: "2026-01-04" });
    expect(plan.target?.sourcePaths).toHaveLength(7);
    expect(plan.target?.missingDates).toEqual([]);
    expect(plan.target?.outputPath).toBe(join(dir, "weekly", "weekly_2025-12-29_2026-01-04.md"));
  });
});

describe("#1864 publication", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cons-pub-1864-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects incomplete, heading-less, and empty-section responses", () => {
    expect(validateConsolidationCompletion("").ok).toBe(false);
    expect(validateConsolidationCompletion("## Truncated\n\n## Phase 1: Infrastructure\n").ok).toBe(false);
    expect(validateConsolidationCompletion(`body only\n${CONSOLIDATION_COMPLETE_MARKER}`).ok).toBe(false);
    expect(validateConsolidationCompletion(`# Title\n\n${CONSOLIDATION_COMPLETE_MARKER}`).ok).toBe(false);
    expect(validateConsolidationCompletion(`# Title\n\ncontent\n\n## Empty\n${CONSOLIDATION_COMPLETE_MARKER}`).ok).toBe(false);
    const ok = validateConsolidationCompletion(COMPLETE_RESPONSE);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.body).not.toContain(CONSOLIDATION_COMPLETE_MARKER);
  });

  it("publishes atomically with a position-anchored header and no temp residue", () => {
    const path = publishConsolidationFile(dir, COMPLETE_RESPONSE, {
      owner: OWNER,
      tier: "weekly",
      period: { start: "2026-04-13", end: "2026-04-19" },
      coveredRange: "2026-04-13 to 2026-04-19",
      sourcePaths: [join(dir, "daily", "d1.md")],
    });
    expect(path).toBe(join(dir, "weekly", "weekly_2026-04-13_2026-04-19.md"));
    const content = readFileSync(path, "utf-8");
    expect(parseConsolidationPeriod(content)).toEqual({ start: "2026-04-13", end: "2026-04-19" });
    expect(parseConsolidationSources(content)).toEqual([join(dir, "daily", "d1.md")]);
    expect(content).not.toContain(CONSOLIDATION_COMPLETE_MARKER);
    expect(readdirSync(join(dir, "weekly")).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("refuses a foreign or invalid artifact already occupying the period path", () => {
    const target = join(dir, "weekly", "weekly_2026-04-13_2026-04-19.md");
    mkdirSync(join(dir, "weekly"), { recursive: true });
    writeFileSync(target, `Owner: mallory\nPeriod-Start: 2026-04-13\nPeriod-End: 2026-04-19\n\n${COMPLETE_RESPONSE}`);
    expect(() => publishConsolidationFile(dir, COMPLETE_RESPONSE, {
      owner: OWNER, tier: "weekly", period: { start: "2026-04-13", end: "2026-04-19" }, coveredRange: "r", sourcePaths: [],
    })).toThrow(/foreign or invalid/);
    writeFileSync(target, `# Weekly\n\nno period header\n`);
    expect(() => publishConsolidationFile(dir, COMPLETE_RESPONSE, {
      owner: OWNER, tier: "weekly", period: { start: "2026-04-13", end: "2026-04-19" }, coveredRange: "r", sourcePaths: [],
    })).toThrow(/foreign or invalid/);
  });

  it("replaces a verified same-owner same-period artifact (retry idempotence)", () => {
    const period = { start: "2026-04-13", end: "2026-04-19" };
    publishConsolidationFile(dir, COMPLETE_RESPONSE, { owner: OWNER, tier: "weekly", period, coveredRange: "first", sourcePaths: [] });
    const second = `# Weekly — retry\n\n## Events\n- corrected\n\n${CONSOLIDATION_COMPLETE_MARKER}`;
    const path = publishConsolidationFile(dir, second, { owner: OWNER, tier: "weekly", period, coveredRange: "second", sourcePaths: [] });
    expect(readFileSync(path, "utf-8")).toContain("corrected");
    expect(readdirSync(join(dir, "weekly"))).toEqual(["weekly_2026-04-13_2026-04-19.md"]);
  });

  it("a failed write leaves no artifact and no temp residue", () => {
    const period = { start: "2026-04-13", end: "2026-04-19" };
    const tierDir = join(dir, "weekly");
    mkdirSync(tierDir, { recursive: true });
    chmodSync(tierDir, 0o500);
    try {
      expect(() => publishConsolidationFile(dir, COMPLETE_RESPONSE, { owner: OWNER, tier: "weekly", period, coveredRange: "r", sourcePaths: [] })).toThrow();
    } finally {
      chmodSync(tierDir, 0o700);
    }
    expect(existsSync(join(tierDir, "weekly_2026-04-13_2026-04-19.md"))).toBe(false);
    expect(readdirSync(tierDir)).toEqual([]);
  });

  it("new-style weekly range names stay visible to discovery and S6 recall", () => {
    const path = publishConsolidationFile(dir, COMPLETE_RESPONSE, {
      owner: OWNER, tier: "weekly", period: { start: "2026-04-13", end: "2026-04-19" }, coveredRange: "r", sourcePaths: [],
    });
    void path;
    const latest = getLatestConsolidationFile(dir, "weekly", OWNER);
    expect(latest?.filePath).toBe(join(dir, "weekly", "weekly_2026-04-13_2026-04-19.md"));
    expect(latest?.timestamp).toBe(Date.parse("2026-04-19T00:00:00Z"));
    expect(searchConsolidationFiles(dir, ["decision"], { requesterUserId: OWNER })).toHaveLength(1);
    expect(searchConsolidationFiles(dir, ["decision"], { requesterUserId: "someone" })).toHaveLength(0);
  });

  it("#1905: a structurally complete nested response validates and publishes", () => {
    // Sanitized equivalent of the recorded Q3 shape: per-day subsections sit
    // directly under the period heading with no direct prose.
    const nested = `# Quarterly — 2026 Q3 (July–September)

## July–September 2026

### 2026-07-06
- shipped the harbor route with summit notes

### 2026-08-19
- a decision was made about the winter schedule

${CONSOLIDATION_COMPLETE_MARKER}`;
    const ok = validateConsolidationCompletion(nested);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const path = publishConsolidationFile(dir, nested, {
      owner: OWNER, tier: "quarterly", period: { start: "2026-07-01", end: "2026-09-30" }, coveredRange: "r", sourcePaths: [],
    });
    expect(path).toBe(join(dir, "quarterly", "quarterly_2026-Q3.md"));
    expect(readFileSync(path, "utf-8")).toContain("### 2026-08-19");
  });

  it("#1905: an empty sibling, an empty leaf, and an empty final heading still fail", () => {
    // Empty sibling cannot borrow the next sibling's body.
    expect(validateConsolidationCompletion(
      `# Quarterly\n\n## July\n\n## August\n- a decision was made\n\n${CONSOLIDATION_COMPLETE_MARKER}`,
    ).ok).toBe(false);
    // Empty leaf under a valid parent.
    expect(validateConsolidationCompletion(
      `# Quarterly\n\nQ3 in review.\n\n## July\n- a decision was made\n\n## August\n\n${CONSOLIDATION_COMPLETE_MARKER}`,
    ).ok).toBe(false);
    // Deeply nested empty leaf.
    expect(validateConsolidationCompletion(
      `# Quarterly\n\n## July–September\n\n### 2026-07-06\n\n${CONSOLIDATION_COMPLETE_MARKER}`,
    ).ok).toBe(false);
    // Truncated stub ending at an empty heading.
    expect(validateConsolidationCompletion(
      `# Quarterly\n\n## July–September\n\n### 2026-07-06\n- shipped\n\n### 2026-08-19\n\n${CONSOLIDATION_COMPLETE_MARKER}`,
    ).ok).toBe(false);
  });

  it("#1905: a transitively valid deep nest passes while a lone title still fails", () => {
    expect(validateConsolidationCompletion(
      `# Quarterly\n\n## July–September\n\n### 2026-07-06\n\n#### Morning\n- shipped the harbor route\n\n${CONSOLIDATION_COMPLETE_MARKER}`,
    ).ok).toBe(true);
    expect(validateConsolidationCompletion(`# Quarterly\n\n${CONSOLIDATION_COMPLETE_MARKER}`).ok).toBe(false);
  });
});

// ── Real-orchestrator acceptance (criteria 1, 2, 5) ─────────────────────────

function baseOpts(env: TestEnv, overrides: Partial<SleepRunOptions> = {}): SleepRunOptions {
  return {
    runtime: env.runtime,
    now: () => env.now,
    timeoutMs: 60_000,
    fresh: true,
    // Manual runs bypass the no-messages guard so repeated same-week runs
    // exercise the consolidation due decision rather than the no-work exit.
    mode: "manual",
    betweenStepBackoffMs: () => 0,
    memoryConfigOverride: { memoryDir: env.memoryDir, memoryEnabled: true },
    ...overrides,
  };
}

function cannedResponses(env: TestEnv): void {
  env.runtime.setDefault("ok");
  env.runtime.setResponse("Update the summary incorporating", "- user asked about X\n- decision Y made\n- a second durable fact worth remembering across sessions");
  env.runtime.setResponse("store a memory using abmind store", "2 memories stored");
  env.runtime.setResponse("retrospective", "Today went well. Flagged nothing.");
  env.runtime.setResponse("Mark small talk", "[]");
}

function readLock(env: TestEnv): { status: string; steps: Record<string, { status: string }> } {
  return JSON.parse(readFileSync(join(env.sleepDir, `sleep_${env.todayStr}.lock`), "utf-8"));
}

function seedWeek(env: TestEnv, start: string, end: string): void {
  for (const day of enumerateDays(start, end)) writeDailyFileFor(env.memoryDir, day, null, `- event on ${day}`);
}

describe("#1864 consolidation through the real orchestrator", () => {
  it("criterion 1: two consecutive runs in one week publish exactly one weekly", async () => {
    const env = await setupTestEnv({ seedMessages: 5, today: "2026-04-20" }); // Monday
    cannedResponses(env);
    env.runtime.setResponse(CONSOLIDATION_COMPLETE_MARKER, COMPLETE_RESPONSE);
    seedWeek(env, "2026-04-13", "2026-04-19");
    try {
      const first = await runSleepCycle(baseOpts(env));
      expect(first.status).toBe("completed");
      const weeklyDir = join(env.memoryDir, "weekly");
      expect(readdirSync(weeklyDir)).toEqual(["weekly_2026-04-13_2026-04-19.md"]);
      const content = readFileSync(join(weeklyDir, "weekly_2026-04-13_2026-04-19.md"), "utf-8");
      expect(content).toContain("Period-Start: 2026-04-13");
      expect(content).toContain("Period-End: 2026-04-19");
      expect(content).toContain("Owner: master");
      const callsAfterFirst = env.runtime.callsFor(CONSOLIDATION_COMPLETE_MARKER).length;
      expect(callsAfterFirst).toBe(1);

      const second = await runSleepCycle(baseOpts(env));
      expect(second.status).toBe("completed");
      expect(readdirSync(weeklyDir)).toEqual(["weekly_2026-04-13_2026-04-19.md"]);
      expect(env.runtime.callsFor(CONSOLIDATION_COMPLETE_MARKER).length).toBe(callsAfterFirst);
      expect(readLock(env).steps["consolidation"]?.status).toBe("skipped");
    } finally {
      env.cleanup();
    }
  });

  it("criterion 2: a due weekly publishes at a quarter boundary; the quarter stays due and publishes later", async () => {
    const env = await setupTestEnv({ seedMessages: 5, today: "2026-07-01" }); // Q3, day 1
    cannedResponses(env);
    env.runtime.setResponse(CONSOLIDATION_COMPLETE_MARKER, COMPLETE_RESPONSE);
    seedWeek(env, "2026-06-22", "2026-06-28");
    try {
      const first = await runSleepCycle(baseOpts(env));
      expect(first.status).toBe("completed");
      expect(readdirSync(join(env.memoryDir, "weekly"))).toEqual(["weekly_2026-06-22_2026-06-28.md"]);
      expect(existsSync(join(env.memoryDir, "quarterly", "quarterly_2026-Q2.md"))).toBe(false);

      // The quarter is still due after weekly success; when its inputs exist
      // it publishes in a later run even past the quarter's first seven days.
      seedWeek(env, "2026-04-01", "2026-06-30");
      const callsAfterFirst = env.runtime.callsFor(CONSOLIDATION_COMPLETE_MARKER).length;
      const second = await runSleepCycle(baseOpts(env));
      expect(second.status).toBe("completed");
      expect(existsSync(join(env.memoryDir, "quarterly", "quarterly_2026-Q2.md"))).toBe(true);
      expect(readdirSync(join(env.memoryDir, "weekly"))).toEqual(["weekly_2026-06-22_2026-06-28.md"]);
      expect(env.runtime.callsFor(CONSOLIDATION_COMPLETE_MARKER).length).toBe(callsAfterFirst + 1);
    } finally {
      env.cleanup();
    }
  });

  it("criterion 5 retry identity (#1905): an old failed lock never dispatches consolidation; the receipt is retained", async () => {
    const env = await setupTestEnv({ seedMessages: 5, today: "2026-04-20" });
    cannedResponses(env);
    try {
      const lockPath = join(env.sleepDir, "sleep_20260418.lock");
      const steps: Record<string, { status: string }> = Object.fromEntries(
        [...essentialSleepSteps()].map((name) => [name, { status: name === "consolidation" ? "failed" : "ok" }]),
      );
      writeFileSync(lockPath, JSON.stringify({ status: "failed", pid: 99999, startedAt: env.now - 2 * 86_400_000, llmCalls: 0, steps }));

      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("completed");
      // No historical-date consolidation dispatch from the old receipt.
      const consolidationCalls = env.runtime.allCalls().filter((c) => c.stepId.includes("consolidation"));
      expect(consolidationCalls).toEqual([]);
      // The old receipt is retained, never re-driven or age-deleted.
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("criterion 5: incomplete output publishes nothing, leaves the period due, and a later run completes it", async () => {
    const env = await setupTestEnv({ seedMessages: 5, today: "2026-04-20" });
    cannedResponses(env);
    env.runtime.setResponse(CONSOLIDATION_COMPLETE_MARKER, "## Truncated — Phase 1\n\n## Phase 1: Infrastructure\n");
    seedWeek(env, "2026-04-13", "2026-04-19");
    try {
      const first = await runSleepCycle(baseOpts(env));
      expect(first.status).not.toBe("failed");
      expect(readdirSync(join(env.memoryDir, "weekly"))).toEqual([]);
      expect(readLock(env).steps["consolidation"]?.status).toBe("failed");

      env.runtime.setResponse(CONSOLIDATION_COMPLETE_MARKER, COMPLETE_RESPONSE);
      await runSleepCycle(baseOpts(env));
      expect(readdirSync(join(env.memoryDir, "weekly"))).toEqual(["weekly_2026-04-13_2026-04-19.md"]);
      expect(readLock(env).steps["consolidation"]?.status).toBe("ok");
    } finally {
      env.cleanup();
    }
  });
});
