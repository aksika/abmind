/**
 * Unit tests for sleep/step-deadlines.ts (#1611).
 *
 * Budgets now come from the sleep.json manifest (sleep/sleep-manifest.ts). These
 * tests isolate ABMIND_HOME in a temp home with no config/sleep.json so they
 * deterministically exercise the in-code DEFAULT_SLEEP_MANIFEST — the shipped
 * policy table. `basic` is a separate code path and keeps the 300s default.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sleepStepDeadlineMs, DEFAULT_SLEEP_STEP_DEADLINE_MS, SLEEP_PROVIDER_CLEANUP_HEADROOM_MS } from "./step-deadlines.js";
import { resetSleepManifestCache } from "./sleep-manifest.js";

const hereDir = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(hereDir, "..", "..", "templates", "prompts", "sleep");

describe("sleepStepDeadlineMs (#1611 policy table)", () => {
  let tmpHome: string;
  const origHome = process.env.HOME;
  const origAbmind = process.env.ABMIND_HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "sleep-deadlines-"));
    process.env.HOME = tmpHome;
    process.env.ABMIND_HOME = tmpHome;
    resetSleepManifestCache();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origAbmind === undefined) delete process.env.ABMIND_HOME;
    else process.env.ABMIND_HOME = origAbmind;
    resetSleepManifestCache();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("every shipped sleep prompt step has an explicit budget in the default manifest", () => {
    const shipped = readdirSync(promptsDir)
      .filter(f => /^\d{2}-.*\.md$/.test(f))
      .map(f => f.replace(/^\d{2}-/, "").replace(/\.md$/, ""));
    expect(shipped.length).toBeGreaterThan(0);
    // Test-local expected mapping: adding a canonical step requires updating
    // BOTH the default manifest and this list — a silent default is impossible.
    const expected: Record<string, number> = {
      "gc-noise": 180_000,
      "daily-summary": 600_000,
      retrospective: 600_000,
      "extract-memories": 600_000,
      "contradiction-and-graph": 300_000,
      "retro-derive": 300_000,
      feedback: 180_000,
      "memory-maintenance": 300_000,
      translation: 180_000,
      "skill-review": 300_000,
      consolidation: 300_000,
      "rem-synthesis": 300_000,
    };
    expect(Object.keys(expected).sort(), "every shipped step must be enumerated here").toEqual([...shipped].sort());
    for (const [stepId, budget] of Object.entries(expected)) {
      expect(sleepStepDeadlineMs(stepId), `step "${stepId}" must honor its explicit budget`).toBe(budget);
    }
  });

  it("applies the documented per-step budgets", () => {
    expect(sleepStepDeadlineMs("gc-noise")).toBe(180_000);
    expect(sleepStepDeadlineMs("feedback")).toBe(180_000);
    expect(sleepStepDeadlineMs("translation")).toBe(180_000);
    expect(sleepStepDeadlineMs("retrospective")).toBe(600_000);
    expect(sleepStepDeadlineMs("contradiction-and-graph")).toBe(300_000);
    expect(sleepStepDeadlineMs("retro-derive")).toBe(300_000);
    expect(sleepStepDeadlineMs("memory-maintenance")).toBe(300_000);
    expect(sleepStepDeadlineMs("skill-review")).toBe(300_000);
    expect(sleepStepDeadlineMs("consolidation")).toBe(300_000);
    expect(sleepStepDeadlineMs("rem-synthesis")).toBe(300_000);
    expect(sleepStepDeadlineMs("daily-summary")).toBe(600_000);
    expect(sleepStepDeadlineMs("extract-memories")).toBe(600_000);
    expect(sleepStepDeadlineMs("basic")).toBe(300_000);
  });

  it("a catch-up step inherits the budget of its underlying step", () => {
    expect(sleepStepDeadlineMs("catch-up-daily-summary")).toBe(600_000);
    expect(sleepStepDeadlineMs("catch-up-extract-memories")).toBe(600_000);
    expect(sleepStepDeadlineMs("catch-up-retrospective")).toBe(600_000);
    expect(sleepStepDeadlineMs("catch-up-gc-noise")).toBe(180_000);
  });

  it("an unknown/custom step receives the documented 300s default", () => {
    expect(sleepStepDeadlineMs("custom-step")).toBe(DEFAULT_SLEEP_STEP_DEADLINE_MS);
    expect(sleepStepDeadlineMs("")).toBe(DEFAULT_SLEEP_STEP_DEADLINE_MS);
  });

  it("cleanup headroom is exactly 30 seconds", () => {
    expect(SLEEP_PROVIDER_CLEANUP_HEADROOM_MS).toBe(30_000);
  });
});
