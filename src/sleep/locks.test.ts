/**
 * Unit tests for sleep/locks.ts — pure date and lock-file helpers (#1229).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  toDateStr,
  toIsoDate,
  dateStrToMs,
  dateStrToFormatted,
  scanPreviousLocks,
} from "./locks.js";

// ── Date helpers ─────────────────────────────────────────────────────────────

describe("toDateStr", () => {
  it("formats a timestamp as YYYYMMDD", () => {
    const ts = new Date("2026-07-08T12:00:00").getTime();
    expect(toDateStr(ts)).toMatch(/^\d{8}$/);
    // The exact value depends on local tz — just verify length and that the
    // year/month digits are embedded.
    expect(toDateStr(ts)).toContain("2026");
  });

  it("pads month and day with leading zeros", () => {
    const ts = new Date("2026-01-05T00:00:00").getTime();
    const s = toDateStr(ts);
    expect(s[4]).toBe("0"); // month leading zero
    expect(s[6]).toBe("0"); // day leading zero
  });
});

describe("toIsoDate", () => {
  it("formats a timestamp as YYYY-MM-DD", () => {
    const ts = new Date("2026-07-08T12:00:00").getTime();
    expect(toIsoDate(ts)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("dateStrToMs", () => {
  it("round-trips with toDateStr", () => {
    const ts = new Date("2026-07-08T00:00:00").getTime();
    const ds = toDateStr(ts);
    expect(dateStrToMs(ds)).toBeGreaterThan(0);
  });

  it("increasing date strings produce increasing timestamps", () => {
    expect(dateStrToMs("20260708")).toBeLessThan(dateStrToMs("20260709"));
    expect(dateStrToMs("20260101")).toBeLessThan(dateStrToMs("20261231"));
  });
});

describe("dateStrToFormatted", () => {
  it("converts YYYYMMDD to YYYY-MM-DD", () => {
    expect(dateStrToFormatted("20260708")).toBe("2026-07-08");
    expect(dateStrToFormatted("20260101")).toBe("2026-01-01");
  });
});

// ── scanPreviousLocks ────────────────────────────────────────────────────────

describe("scanPreviousLocks", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "abmind-locks-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty array when sleepDir does not exist", () => {
    expect(scanPreviousLocks(join(dir, "nonexistent"), "20260708")).toEqual([]);
  });

  it("returns empty array when no lock files exist", () => {
    mkdirSync(dir, { recursive: true });
    expect(scanPreviousLocks(dir, "20260708")).toEqual([]);
  });

  it("skips today's lock file", () => {
    const today = "20260708";
    writeFileSync(join(dir, `sleep_${today}.lock`), JSON.stringify({ status: "completed", pid: 1, startedAt: 0, llmCalls: 0, steps: {} }));
    expect(scanPreviousLocks(dir, today)).toEqual([]);
  });

  it("returns previous day lock with correct age", () => {
    const yesterday = "20260707";
    const today = "20260708";
    const state = { status: "ongoing", pid: 1, startedAt: 0, llmCalls: 0, steps: { "daily-summary": { status: "failed" } } };
    writeFileSync(join(dir, `sleep_${yesterday}.lock`), JSON.stringify(state));

    const locks = scanPreviousLocks(dir, today);
    expect(locks).toHaveLength(1);
    expect(locks[0]!.dateStr).toBe(yesterday);
    expect(locks[0]!.ageDays).toBe(1);
    expect(locks[0]!.state.status).toBe("ongoing");
  });

  it("sorts multiple locks newest-first", () => {
    const today = "20260710";
    const older = "20260707";
    const newer = "20260709";
    const state = (s: string) => ({ status: s, pid: 1, startedAt: 0, llmCalls: 0, steps: {} });
    writeFileSync(join(dir, `sleep_${older}.lock`), JSON.stringify(state("completed")));
    writeFileSync(join(dir, `sleep_${newer}.lock`), JSON.stringify(state("ongoing")));

    const locks = scanPreviousLocks(dir, today);
    expect(locks).toHaveLength(2);
    expect(locks[0]!.dateStr).toBe(newer);
    expect(locks[1]!.dateStr).toBe(older);
  });

  it("ignores malformed lock files", () => {
    writeFileSync(join(dir, "sleep_20260707.lock"), "not json");
    expect(scanPreviousLocks(dir, "20260708")).toEqual([]);
  });

  it("ignores non-lock files", () => {
    writeFileSync(join(dir, "sleep_20260707_1200.md"), "# audit");
    writeFileSync(join(dir, "other.txt"), "data");
    expect(scanPreviousLocks(dir, "20260708")).toEqual([]);
  });
});
