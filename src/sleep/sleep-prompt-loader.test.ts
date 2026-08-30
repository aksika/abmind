import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StateSnapshot } from "../sleep-state-gatherer.js";
import { resetSleepManifestCache } from "./sleep-manifest.js";

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
    dbStats: { messageCount: 100, messagesSinceLastSleep: 0, embeddingCount: 0, nullEmbeddingCount: 0, extractedMemoryCount: 50, compressionRatio: 0, darwinism: { avgRecallCount: 0, avgRelevanceScore: 0, neverRecalled: 0, recalledLast30d: 0 } },
    fts5Health: { messages_fts: "ok", extracted_memories_fts: "ok", extracted_memories_original_fts: "ok" },
    diskUsageBytes: 10 * 1024 * 1024,
    diskBudgetBytes: 500 * 1024 * 1024,
    topicFiles: [],
    lastSleepAudit: "2026-03-14T08:00:00Z",
    lastSleepTimestamp: null,
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
  const origAbmind = process.env.ABMIND_HOME;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sleep-steps-"));
    process.env.HOME = tmpDir;
    delete process.env.ABMIND_HOME; // let abmindHome() fall through to homedir()
    resetSleepManifestCache();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origAbmind === undefined) delete process.env.ABMIND_HOME;
    else process.env.ABMIND_HOME = origAbmind;
    resetSleepManifestCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function sleepDir(): string {
    return join(tmpDir, ".abmind", "prompts", "sleep");
  }

  function configDir(): string {
    return join(tmpDir, ".abmind", "config");
  }

  function writePrompt(filename: string, content: string): void {
    mkdirSync(sleepDir(), { recursive: true });
    writeFileSync(join(sleepDir(), filename), content);
  }

  /** Write a synthetic sleep.json so the test exercises its own manifest
   *  rather than the 12-step fallback default. */
  function writeManifest(steps: Array<{ name: string; prompt: string; timeoutSec?: number; essential?: boolean; runOn?: string[] }>): void {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(join(configDir(), "sleep.json"), JSON.stringify({
      version: 1,
      defaults: { timeoutSec: 300, essential: false },
      steps: steps.map(s => ({ ...s, runOn: s.runOn ?? ["normal"] })),
    }));
    resetSleepManifestCache();
  }

  it("loads steps in manifest order, not filesystem order", () => {
    writePrompt("01-retro.md", "Do retro for ${WAKEUP_DATE}");
    writePrompt("00-identity.md", "You are Dreamy. State: ${DISK_USAGE_MB} MB");
    writeManifest([
      { name: "identity", prompt: "00-identity.md" },
      { name: "retro", prompt: "01-retro.md" },
    ]);

    const steps = loadSleepSteps();

    expect(steps).toHaveLength(2);
    // Manifest order wins regardless of filename ordering.
    expect(steps[0]!.name).toBe("identity");
    expect(steps[0]!.filename).toBe("00-identity.md");
    expect(steps[0]!.rawPrompt).toContain("${DISK_USAGE_MB}");
    expect(steps[1]!.name).toBe("retro");
    expect(steps[1]!.rawPrompt).toContain("${WAKEUP_DATE}");
  });

  it("attaches manifest policy (timeout, essential, runOn) to loaded steps", () => {
    writePrompt("01-mem.md", "memories");
    writeManifest([
      { name: "mem", prompt: "01-mem.md", timeoutSec: 600, essential: true, runOn: ["normal", "ultimate"] },
    ]);

    const steps = loadSleepSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0]!.timeoutMs).toBe(600_000);
    expect(steps[0]!.essential).toBe(true);
    expect(steps[0]!.runOn).toEqual(["normal", "ultimate"]);
  });

  it("throws when $ABMIND_HOME/prompts/sleep absent", () => {
    // ABMIND_HOME points at tmpDir which has no prompts/sleep.
    // After #1158, there's no fallback — reconcile must populate the dir.
    expect(() => loadSleepSteps()).toThrow("Sleep prompts not found");
  });

  it("JIT substitution accumulates vars across steps", () => {
    writePrompt("01-step-a.md", "Input: ${STATIC_VAR}");
    writePrompt("02-step-b.md", "Previous output: ${STEP_A_OUTPUT}");
    writeManifest([
      { name: "step-a", prompt: "01-step-a.md" },
      { name: "step-b", prompt: "02-step-b.md" },
    ]);

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