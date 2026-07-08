import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StateSnapshot } from "../sleep-state-gatherer.js";

// Must mock before import
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => process.env.HOME ?? "/nonexistent-home" };
});

import { loadSleepSteps, buildSleepVars, substituteVars } from "./sleep-prompt-loader.js";

function makeSnapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    timestamp: "2026-03-15T10:00:00Z",
    workingDirs: [],
    dbStats: { messageCount: 100, extractedMemoryCount: 50, embeddingCount: 0, sessionCount: 2 },
    fts5Health: { messages_fts: "ok", extracted_memories_fts: "ok", extracted_memories_original_fts: "ok" },
    diskUsageBytes: 10 * 1024 * 1024,
    diskBudgetBytes: 500 * 1024 * 1024,
    topicFiles: [],
    lastSleepAudit: "2026-03-14T08:00:00Z",
    wakeupDate: "2026-03-15",
    todoContents: "- Buy milk",
    cronContents: "[]",
    ...overrides,
  };
}

describe("substituteVars", () => {
  it("replaces all matching variables", () => {
    const result = substituteVars("Hello ${NAME}, today is ${DATE}", { NAME: "Dreamy", DATE: "Monday" });
    expect(result).toBe("Hello Dreamy, today is Monday");
  });

  it("leaves unmatched variables intact", () => {
    const result = substituteVars("${KNOWN} and ${UNKNOWN}", { KNOWN: "yes" });
    expect(result).toContain("yes");
    expect(result).toContain("${UNKNOWN}");
  });
});

describe("buildSleepVars", () => {
  it("includes all required template variables", () => {
    const vars = buildSleepVars(makeSnapshot());
    expect(vars.WAKEUP_DATE).toBe("2026-03-15");
    expect(vars.LAST_SLEEP_AUDIT).toBe("2026-03-14T08:00:00Z");
    expect(vars.TODO_CONTENTS).toBe("- Buy milk");
    expect(vars.AUDIT_FILENAME).toMatch(/^\d{8}_\d{4}$/);
    expect(vars.DISK_USAGE_MB).toBe("10.0");
    expect(vars.DISK_BUDGET_MB).toBe("500");
  });
});

describe("loadSleepSteps", () => {
  let tmpDir: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sleep-steps-"));
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads and orders step files alphabetically", () => {
    const sleepDir = join(tmpDir, ".abmind", "prompts", "sleep");
    const { mkdirSync } = require("node:fs");
    mkdirSync(sleepDir, { recursive: true });
    writeFileSync(join(sleepDir, "01-retro.md"), "Do retro for ${WAKEUP_DATE}");
    writeFileSync(join(sleepDir, "00-identity.md"), "You are Dreamy. State: ${DISK_USAGE_MB} MB");

    const steps = loadSleepSteps();

    // User files override package files with same name; total includes package + user
    expect(steps.length).toBeGreaterThanOrEqual(2);
    // Steps are ordered alphabetically by filename
    const identity = steps.find(s => s.filename === "00-identity.md")!;
    const retro = steps.find(s => s.filename === "01-retro.md")!;
    expect(identity).toBeDefined();
    expect(identity.name).toBe("identity");
    expect(identity.rawPrompt).toContain("${DISK_USAGE_MB}");
    expect(retro).toBeDefined();
    expect(retro.rawPrompt).toContain("${WAKEUP_DATE}");
    // Alphabetical ordering
    const idxIdentity = steps.indexOf(identity);
    const idxRetro = steps.indexOf(retro);
    expect(idxIdentity).toBeLessThan(idxRetro);
  });

  it("marks essential steps as non-skippable", () => {
    const sleepDir = join(tmpDir, ".abmind", "prompts", "sleep");
    const { mkdirSync } = require("node:fs");
    mkdirSync(sleepDir, { recursive: true });
    writeFileSync(join(sleepDir, "01-gc-noise.md"), "gc");
    writeFileSync(join(sleepDir, "04-retrospective.md"), "retro");
    writeFileSync(join(sleepDir, "07-topic-assignment.md"), "topics");

    const steps = loadSleepSteps();

    expect(steps.find(s => s.name === "gc-noise")!.skippable).toBe(false);
    expect(steps.find(s => s.name === "retrospective")!.skippable).toBe(false);
    expect(steps.find(s => s.name === "topic-assignment")!.skippable).toBe(true);
  });

  it("throws when $ABMIND_HOME/prompts/sleep absent", () => {
    // ABMIND_HOME points at tmpDir which has no prompts/sleep.
    // After #1158, there's no fallback — reconcile must populate the dir.
    expect(() => loadSleepSteps()).toThrow("Sleep prompts not found");
  });

  it("JIT substitution accumulates vars across steps", () => {
    const sleepDir = join(tmpDir, ".abmind", "prompts", "sleep");
    const { mkdirSync } = require("node:fs");
    mkdirSync(sleepDir, { recursive: true });
    writeFileSync(join(sleepDir, "01-step-a.md"), "Input: ${STATIC_VAR}");
    writeFileSync(join(sleepDir, "02-step-b.md"), "Previous output: ${STEP_A_OUTPUT}");

    const steps = loadSleepSteps();
    const stepA = steps.find(s => s.filename === "01-step-a.md")!;
    const stepB = steps.find(s => s.filename === "02-step-b.md")!;
    expect(stepA).toBeDefined();
    expect(stepB).toBeDefined();

    const vars: Record<string, string> = { STATIC_VAR: "hello" };

    // Step 1: substitute with static vars
    const prompt1 = substituteVars(stepA.rawPrompt, vars);
    expect(prompt1).toBe("Input: hello");

    // Simulate step 1 output
    vars.STEP_A_OUTPUT = "result from step a";

    // Step 2: substitute with accumulated vars
    const prompt2 = substituteVars(stepB.rawPrompt, vars);
    expect(prompt2).toBe("Previous output: result from step a");
  });
});
