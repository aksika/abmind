/**
 * Unit tests for sleep/sleep-manifest.ts (#1734).
 *
 * The manifest is the single source of truth for sleep step policy. These
 * tests protect: order/membership of the shipped 12 steps, the eligibility
 * table (level × curation-day × gates), the never-throw fallback, the
 * timeout clamp, and the per-step drop rules.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadSleepManifest,
  sleepStepConfig,
  isSleepStepEligible,
  resetSleepManifestCache,
  type SleepEligibilityContext,
} from "./sleep-manifest.js";
import type { Level } from "./levels.js";

const hereDir = dirname(fileURLToPath(import.meta.url));
const promptsSrc = join(hereDir, "..", "..", "templates", "prompts", "sleep");
const manifestSrc = join(hereDir, "..", "..", "templates", "config", "sleep.json");

const SHIPPED_ORDER = readdirSync(promptsSrc)
  .filter(f => /^\d{2}-.*\.md$/.test(f))
  .sort()
  .map(f => f.replace(/^\d{2}-/, "").replace(/\.md$/, ""));

describe("sleep-manifest", () => {
  let tmpHome: string;
  const origHome = process.env.HOME;
  const origAbmind = process.env.ABMIND_HOME;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "sleep-manifest-"));
    process.env.HOME = tmpHome;
    process.env.ABMIND_HOME = tmpHome;
    // Real prompts must exist for file-based validation.
    mkdirSync(join(tmpHome, "prompts", "sleep"), { recursive: true });
    for (const f of readdirSync(promptsSrc)) {
      if (f.endsWith(".md")) copyFileSync(join(promptsSrc, f), join(tmpHome, "prompts", "sleep", f));
    }
    resetSleepManifestCache();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origAbmind === undefined) delete process.env.ABMIND_HOME;
    else process.env.ABMIND_HOME = origAbmind;
    resetSleepManifestCache();
    vi.restoreAllMocks();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeManifestRaw(content: string): void {
    mkdirSync(join(tmpHome, "config"), { recursive: true });
    writeFileSync(join(tmpHome, "config", "sleep.json"), content);
    resetSleepManifestCache();
  }

  function writeManifest(obj: unknown): void {
    writeManifestRaw(JSON.stringify(obj));
  }

  function writeShippedManifest(): void {
    if (existsSync(manifestSrc)) {
      mkdirSync(join(tmpHome, "config"), { recursive: true });
      copyFileSync(manifestSrc, join(tmpHome, "config", "sleep.json"));
    }
    resetSleepManifestCache();
  }

  function eligibleNames(context: SleepEligibilityContext): string[] {
    return loadSleepManifest().filter(s => isSleepStepEligible(s, context)).map(s => s.name);
  }

  function baseContext(overrides: Partial<SleepEligibilityContext> = {}): SleepEligibilityContext {
    return {
      level: "normal",
      isCurationDay: false,
      hasShortMessages: true,
      hasRecallFeedback: true,
      hasMaintenanceCandidates: true,
      hasTranslationIssues: true,
      extractedMemoryCount: 20,
      ...overrides,
    };
  }

  it("order invariant: manifest order equals the shipped 01…12 prompt order", () => {
    writeShippedManifest();
    const names = loadSleepManifest().map(s => s.name);
    expect(names).toEqual(SHIPPED_ORDER);
  });

  it("the in-code default manifest preserves the same order and membership", () => {
    // No config/sleep.json — default manifest must reproduce today's steps.
    const names = loadSleepManifest().map(s => s.name);
    expect(names).toEqual(SHIPPED_ORDER);
  });

  it("eligibility table: level × curation-day resolution asserted literally", () => {
    writeShippedManifest();
    const all = SHIPPED_ORDER;
    const cases: Array<{ level: Level; curation: boolean; expected: string[] }> = [
      { level: "budget", curation: false, expected: ["gc-noise", "daily-summary", "extract-memories"] },
      { level: "budget", curation: true, expected: ["gc-noise", "daily-summary", "retrospective", "extract-memories", "retro-derive"] },
      { level: "normal", curation: false, expected: ["gc-noise", "daily-summary", "retrospective", "extract-memories", "contradiction-and-graph", "retro-derive", "feedback"] },
      { level: "normal", curation: true, expected: all },
      { level: "ultimate", curation: false, expected: all },
      { level: "ultimate", curation: true, expected: all },
    ];
    for (const c of cases) {
      const got = eligibleNames(baseContext({ level: c.level, isCurationDay: c.curation }));
      expect(got, `level=${c.level} curation=${c.curation}`).toEqual(c.expected);
    }
  });

  it("eligibility gate rows: each gate excludes exactly its step(s)", () => {
    writeShippedManifest();
    // Base resolution: normal non-curation = 7, normal curation = 12.
    const rows: Array<{ name: string; context: SleepEligibilityContext; excluded: string[]; baseCount: number }> = [
      { name: "no short messages", context: baseContext({ hasShortMessages: false }), excluded: ["gc-noise"], baseCount: 7 },
      { name: "no recall feedback", context: baseContext({ hasRecallFeedback: false }), excluded: ["feedback"], baseCount: 7 },
      { name: "no maintenance candidates (curation)", context: baseContext({ isCurationDay: true, hasMaintenanceCandidates: false }), excluded: ["memory-maintenance"], baseCount: 12 },
      { name: "few extracted memories (curation)", context: baseContext({ isCurationDay: true, extractedMemoryCount: 9 }), excluded: ["memory-maintenance", "rem-synthesis"], baseCount: 12 },
      { name: "no translation issues (curation)", context: baseContext({ isCurationDay: true, hasTranslationIssues: false }), excluded: ["translation"], baseCount: 12 },
    ];
    for (const row of rows) {
      const got = eligibleNames(row.context);
      for (const name of row.excluded) {
        expect(got, `${row.name}: ${name} must be excluded`).not.toContain(name);
      }
      expect(got.length, `${row.name}: only the named steps may be excluded`).toBe(row.baseCount - row.excluded.length);
    }
  });

  it("fallback: absent and corrupt sleep.json yield the default manifest with a warning, never a throw", () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Absent file.
    expect(loadSleepManifest()).toHaveLength(SHIPPED_ORDER.length);
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes("using in-code default manifest"))).toBe(true);

    warnSpy.mockClear();
    // Corrupt JSON.
    writeManifestRaw("{ not json !!!");
    expect(loadSleepManifest()).toHaveLength(SHIPPED_ORDER.length);
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes("using in-code default manifest"))).toBe(true);

    warnSpy.mockClear();
    // Unsupported version.
    writeManifest({ version: 2, defaults: {}, steps: [] });
    expect(loadSleepManifest()).toHaveLength(SHIPPED_ORDER.length);

    warnSpy.mockClear();
    // Empty steps array.
    writeManifest({ version: 1, defaults: {}, steps: [] });
    expect(loadSleepManifest()).toHaveLength(SHIPPED_ORDER.length);
  });

  it("clamp: timeoutSec outside 60–900 warns and clamps", () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeManifest({
      version: 1,
      defaults: { timeoutSec: 300, essential: false },
      steps: [
        { name: "gc-noise", prompt: "01-gc-noise.md", timeoutSec: 10, runOn: ["normal"] },
        { name: "daily-summary", prompt: "02-daily-summary.md", timeoutSec: 5000, runOn: ["normal"] },
      ],
    });
    const steps = loadSleepManifest();
    expect(steps.find(s => s.name === "gc-noise")!.timeoutMs).toBe(60_000);
    expect(steps.find(s => s.name === "daily-summary")!.timeoutMs).toBe(900_000);
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes("clamped"))).toBe(true);
  });

  it("drop rules: a step whose prompt file is missing is dropped with a warning", () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeManifest({
      version: 1,
      defaults: { timeoutSec: 300, essential: false },
      steps: [
        { name: "gc-noise", prompt: "01-gc-noise.md", runOn: ["normal"] },
        { name: "ghost-step", prompt: "99-ghost.md", runOn: ["normal"] },
      ],
    });
    const steps = loadSleepManifest();
    expect(steps.map(s => s.name)).toEqual(["gc-noise"]);
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes("not present"))).toBe(true);
  });

  it("structural validation: duplicates and invalid runOn warn and cannot create duplicate work", () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeManifest({
      version: 1,
      defaults: { timeoutSec: 300, essential: false },
      steps: [
        { name: "gc-noise", prompt: "01-gc-noise.md", runOn: ["normal"] },
        { name: "gc-noise", prompt: "03-retrospective.md", runOn: ["normal"] },
        { name: "daily-summary", prompt: "02-daily-summary.md", runOn: ["normal", "bogus-token"] },
        { name: "retrospective", prompt: "03-retrospective.md", runOn: ["normal"] },
        { name: "retro-copy", prompt: "03-retrospective.md", runOn: ["normal"] },
        { name: "bad-runon", prompt: "04-extract-memories.md", runOn: ["totally-invalid"] },
      ],
    });
    const steps = loadSleepManifest();
    const names = steps.map(s => s.name);
    expect(names).toEqual(["gc-noise", "daily-summary", "retrospective"]);
    expect(steps.find(s => s.name === "daily-summary")!.runOn).toEqual(["normal"]);
    const warns = warnSpy.mock.calls.map(c => String(c[0])).join("\n");
    expect(warns).toContain("duplicate step name");
    expect(warns).toContain("duplicate prompt");
    expect(warns).toContain("invalid");
  });

  it("structural validation: zero usable steps after dropping falls back to the default manifest", () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeManifest({
      version: 1,
      defaults: { timeoutSec: 300, essential: false },
      steps: [
        { name: "broken", prompt: "01-gc-noise.md", runOn: ["not-a-level"] },
      ],
    });
    expect(loadSleepManifest()).toHaveLength(SHIPPED_ORDER.length);
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes("zero usable steps"))).toBe(true);
  });

  it("sleepStepConfig resolves by exact name only", () => {
    writeShippedManifest();
    expect(sleepStepConfig("retrospective")?.timeoutMs).toBe(600_000);
    expect(sleepStepConfig("catch-up-retrospective")).toBeUndefined();
    expect(sleepStepConfig("nope")).toBeUndefined();
  });

  it("retrospective is essential and carries the 600s budget", () => {
    writeShippedManifest();
    const retro = sleepStepConfig("retrospective")!;
    expect(retro.essential).toBe(true);
    expect(retro.timeoutMs).toBe(600_000);
  });
});