import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { hasSleepAuditToday } from "./trigger.js";

const TMP = join(import.meta.dirname, "..", "..", ".test-sleep-trigger");

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

describe("hasSleepAuditToday", () => {
  it("returns false if dir does not exist", () => {
    expect(hasSleepAuditToday("/nonexistent")).toBe(false);
  });

  it("returns false if no files for today", () => {
    expect(hasSleepAuditToday(TMP)).toBe(false);
  });

  it("returns true if audit .md exists for today", () => {
    writeFileSync(join(TMP, `sleep_${todayStr()}_0900.md`), "# Audit");
    expect(hasSleepAuditToday(TMP)).toBe(true);
  });

  it("returns false if lock has failed steps", () => {
    const state = { pid: 1, startedAt: Date.now(), steps: { "04a": { status: "failed" } } };
    writeFileSync(join(TMP, `sleep_${todayStr()}.lock`), JSON.stringify(state));
    expect(hasSleepAuditToday(TMP)).toBe(false);
  });

  it("returns false if lock status is suspended (budget exhausted)", () => {
    const state = { status: "suspended", pid: 1, startedAt: Date.now(), steps: {} };
    writeFileSync(join(TMP, `sleep_${todayStr()}.lock`), JSON.stringify(state));
    expect(hasSleepAuditToday(TMP)).toBe(false);
  });

  it("returns true if lock status is completed", () => {
    const state = { status: "completed", pid: 1, startedAt: Date.now(), steps: {} };
    writeFileSync(join(TMP, `sleep_${todayStr()}.lock`), JSON.stringify(state));
    expect(hasSleepAuditToday(TMP)).toBe(true);
  });

  it("returns true if lock has all ok steps and audit exists", () => {
    const state = { pid: 1, startedAt: Date.now(), steps: { "04a": { status: "ok" }, "retro": { status: "skipped" } } };
    writeFileSync(join(TMP, `sleep_${todayStr()}.lock`), JSON.stringify(state));
    writeFileSync(join(TMP, `sleep_${todayStr()}_0900.md`), "# Audit");
    expect(hasSleepAuditToday(TMP)).toBe(true);
  });
});
