/**
 * Unit tests for sleep/locks.ts — pure date helpers (#1229).
 * #1905 removed the stale-lock recovery scan: locks are run receipts only.
 */

import { describe, it, expect } from "vitest";
import {
  toDateStr,
  toIsoDate,
  dateStrToFormatted,
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

describe("dateStrToFormatted", () => {
  it("converts YYYYMMDD to YYYY-MM-DD", () => {
    expect(dateStrToFormatted("20260708")).toBe("2026-07-08");
    expect(dateStrToFormatted("20260101")).toBe("2026-01-01");
  });
});
