/**
 * #1860 coverage ledger: claim parsing, ceiling predicate, needed-set, and
 * session-scope classification.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCoverageClaims,
  coverageCeilingTs,
  unclaimedRanges,
  hasUnclaimedRanges,
  isConsumedSleepSession,
  scopeOfSession,
  mergeExcluded,
} from "./coverage.js";
import { catchupNeeded, manifestOrdered } from "./catchup.js";
import { writeStateFile, readStateFile } from "./state.js";
import type { SleepState } from "./state.js";
import type { CoverageClaim } from "./coverage.js";

function stateWith(steps: SleepState["steps"]): SleepState {
  return { status: "ongoing", pid: 1, startedAt: 0, llmCalls: 0, steps };
}

function claim(overrides: Partial<CoverageClaim> = {}): CoverageClaim {
  return {
    principal: "master", scope: "A", startTs: 1000, endTs: 2000,
    disposition: "covered", ...overrides,
  };
}

describe("parseCoverageClaims", () => {
  it("absent (legacy) stays absent — the caller treats it as unclaimed", () => {
    expect(parseCoverageClaims(undefined)).toBeUndefined();
  });

  it("drops a non-array field whole instead of invalidating the lock", () => {
    expect(parseCoverageClaims({ startTs: 1 })).toBeUndefined();
  });

  it("passes valid covered/excluded/unclaimed claims", () => {
    const raw = [
      claim(),
      claim({ disposition: "excluded", scope: "excluded", reason: "garbage-marked" }),
      claim({ disposition: "unclaimed", startTs: 3000, endTs: 4000 }),
    ];
    expect(parseCoverageClaims(raw)).toEqual(raw);
  });

  it("invalidates the whole claim field when one entry is malformed", () => {
    const good = claim();
    const parsed = parseCoverageClaims([
      good,
      { principal: "", scope: "A", startTs: 1, endTs: 2, disposition: "covered" },
      { principal: "m", scope: "Z", startTs: 1, endTs: 2, disposition: "covered" },
      { principal: "m", scope: "A", startTs: 5, endTs: 2, disposition: "covered" },
      { principal: "m", scope: "excluded", startTs: 1, endTs: 2, disposition: "excluded" },
      "not-an-object",
    ]);
    expect(parsed).toBeUndefined();
  });
});

describe("coverageCeilingTs", () => {
  const TARGET = 10_000;

  it("returns null without claim data — legacy holds the watermark", () => {
    const s = stateWith({ "daily-summary": { status: "ok" } });
    expect(coverageCeilingTs(s, "master", TARGET)).toBeNull();
  });

  it("returns null when daily-summary did not run", () => {
    const s = stateWith({ "daily-summary": { status: "skipped" } });
    expect(coverageCeilingTs(s, "master", TARGET)).toBeNull();
  });

  it("returns the target when everything is claimed", () => {
    const s = stateWith({
      "daily-summary": { status: "ok", claims: [claim({ startTs: 1000, endTs: 9000 })] },
    });
    expect(coverageCeilingTs(s, "master", TARGET)).toBe(TARGET);
  });

  it("lands immediately below the first hole", () => {
    const s = stateWith({
      "daily-summary": {
        status: "ok",
        claims: [
          claim({ startTs: 1000, endTs: 2000 }),
          claim({ disposition: "unclaimed", startTs: 3000, endTs: 4000 }),
          claim({ startTs: 5000, endTs: 9000 }),
        ],
      },
    });
    expect(coverageCeilingTs(s, "master", TARGET)).toBe(2999);
  });

  it("ignores holes above the target and other principals' holes", () => {
    const s = stateWith({
      "daily-summary": {
        status: "ok",
        claims: [
          claim({ startTs: 1000, endTs: 9000 }),
          claim({ disposition: "unclaimed", startTs: 20_000, endTs: 21_000 }),
          claim({ principal: "other", disposition: "unclaimed", startTs: 1500, endTs: 1600 }),
        ],
      },
    });
    expect(coverageCeilingTs(s, "master", TARGET)).toBe(TARGET);
  });
});

describe("unclaimed bookkeeping", () => {
  it("reports explicit unclaimed ranges per principal", () => {
    const s = stateWith({
      "daily-summary": {
        status: "ok",
        claims: [
          claim(),
          claim({ disposition: "unclaimed", startTs: 3000, endTs: 4000 }),
        ],
      },
    });
    expect(hasUnclaimedRanges(s)).toBe(true);
    expect(hasUnclaimedRanges(s, "other")).toBe(false);
    expect(unclaimedRanges(s, "master")).toEqual([{ startTs: 3000, endTs: 4000 }]);
  });

  it("skipped daily needs no recovery; failed daily is a failed essential", () => {
    const skipped = stateWith({
      "daily-summary": { status: "skipped" },
      "retrospective": { status: "ok" },
      "extract-memories": { status: "ok" },
    });
    expect(catchupNeeded(skipped)).toEqual([]);
    expect(coverageCeilingTs(skipped, "master", 10_000)).toBeNull();
  });
});

describe("session-scope classification", () => {
  it.each([
    ["", true],
    ["plain", true],
    ["main", true],
    ["test-session", true],
    ["master:telegram", true],
    ["sess_A_1", true],
    ["sess_C_2", true],
    ["sess_W_1", false],
    ["worker_orc_9", false],
  ])("isConsumedSleepSession(%j) === %j", (sessionId, expected) => {
    expect(isConsumedSleepSession(sessionId)).toBe(expected);
  });

  it("attributes dual-marker ids to A", () => {
    expect(scopeOfSession("x_A_y")).toBe("A");
    expect(scopeOfSession("x_C_y")).toBe("C");
    expect(scopeOfSession("x_A_y_C_z")).toBe("A");
    expect(scopeOfSession("plain")).toBe("A");
  });

  it("merges excluded marks per reason", () => {
    expect(mergeExcluded([
      { startTs: 5, endTs: 5, reason: "system-prefix" },
      { startTs: 1, endTs: 3, reason: "garbage-marked" },
      { startTs: 2, endTs: 4, reason: "garbage-marked" },
    ])).toEqual([
      { startTs: 5, endTs: 5, reason: "system-prefix" },
      { startTs: 1, endTs: 4, reason: "garbage-marked" },
    ]);
  });
});

describe("catchupNeeded and manifestOrdered", () => {
  it("a hole alone keeps daily-summary in the needed set", () => {
    const s = stateWith({
      "daily-summary": {
        status: "ok",
        claims: [claim(), claim({ disposition: "unclaimed", startTs: 3000, endTs: 4000 })],
      },
      "retrospective": { status: "ok" },
      "extract-memories": { status: "ok" },
    });
    expect(catchupNeeded(s)).toEqual(["daily-summary"]);
  });

  it("legacy completed locks without claim data stay recoverable", () => {
    const legacy = stateWith({
      "daily-summary": { status: "ok" },
      "retrospective": { status: "ok" },
      "extract-memories": { status: "ok" },
    });
    // Unknown legacy coverage is not proof: settlement holds and catch-up
    // rebuilds the date range before the lock can be removed.
    expect(catchupNeeded(legacy)).toEqual(["daily-summary"]);
    expect(coverageCeilingTs(legacy, "master", 10_000)).toBeNull();

    const clean = stateWith({
      "daily-summary": { status: "ok", claims: [claim()] },
      "retrospective": { status: "ok" },
      "extract-memories": { status: "ok" },
    });
    expect(catchupNeeded(clean)).toEqual([]);
  });

  it("orders needed steps by manifest declaration: daily, retrospective, extraction", () => {
    expect(manifestOrdered(["extract-memories", "retrospective", "daily-summary"]))
      .toEqual(["daily-summary", "retrospective", "extract-memories"]);
  });
});

describe("state-file claim round-trip", () => {
  it("persists valid claims and drops malformed ones without losing the lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "claims-"));
    try {
      const path = join(dir, "sleep_20260415.lock");
      const state = stateWith({
        "daily-summary": {
          status: "ok", path: "/tmp/d.md",
          claims: [claim(), claim({ disposition: "unclaimed", startTs: 3000, endTs: 4000 })],
        },
      });
      writeStateFile(path, state);
      expect(readStateFile(path)?.steps["daily-summary"]?.claims).toHaveLength(2);

      // Malformed claims degrade to unclaimed, not to an unreadable lock.
      const malformed = {
        status: "ongoing", pid: 1, startedAt: 0, llmCalls: 0,
        steps: { "daily-summary": { status: "ok", claims: "garbage" } },
      };
      writeFileSync(path, JSON.stringify(malformed));
      const parsed = readStateFile(path);
      expect(parsed).not.toBeNull();
      expect(parsed?.steps["daily-summary"]?.status).toBe("ok");
      expect(parsed?.steps["daily-summary"]?.claims).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
