/**
 * Unit tests for sleep/state.ts — state-file serialization round-trips (#1229).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStateFile, writeStateFile } from "./state.js";
import type { SleepState } from "./state.js";

describe("readStateFile / writeStateFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "abmind-state-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const base: SleepState = {
    status: "ongoing",
    pid: 12345,
    startedAt: 1_700_000_000_000,
    llmCalls: 3,
    steps: { "daily-summary": { status: "ok", duration: 5.2 } },
  };

  it("round-trips a complete state object", () => {
    const path = join(dir, "sleep_20260708.lock");
    writeStateFile(path, base);
    const read = readStateFile(path);
    expect(read).not.toBeNull();
    expect(read!.status).toBe("ongoing");
    expect(read!.pid).toBe(12345);
    expect(read!.llmCalls).toBe(3);
    expect(read!.steps["daily-summary"]?.status).toBe("ok");
  });

  it("returns null for a missing file", () => {
    expect(readStateFile(join(dir, "nonexistent.lock"))).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    const path = join(dir, "bad.lock");
    writeStateFile(path, base);
    // Overwrite with garbage
    writeFileSync(path, "not json");
    expect(readStateFile(path)).toBeNull();
  });

  it("returns null for JSON missing .steps", () => {
    const path = join(dir, "nosteps.lock");
    writeFileSync(path, JSON.stringify({ status: "ongoing", pid: 1, startedAt: 0, llmCalls: 0 }));
    expect(readStateFile(path)).toBeNull();
  });

  it("backfills legacy status=undefined to 'ongoing'", () => {
    const path = join(dir, "legacy.lock");
    // Write a lock without status field
    writeFileSync(path, JSON.stringify({ pid: 1, startedAt: 0, llmCalls: 0, steps: {} }));
    const read = readStateFile(path);
    expect(read).not.toBeNull();
    expect(read!.status).toBe("ongoing");
  });

  it("backfills legacy llmCalls=null to 0", () => {
    const path = join(dir, "legacy2.lock");
    writeFileSync(path, JSON.stringify({ status: "ongoing", pid: 1, startedAt: 0, llmCalls: null, steps: {} }));
    const read = readStateFile(path);
    expect(read).not.toBeNull();
    expect(read!.llmCalls).toBe(0);
  });

  it("preserves step details including duration and attempts", () => {
    const state: SleepState = {
      ...base,
      steps: {
        "daily-summary": { status: "ok", duration: 12.5, attempts: 2 },
        "extract-memories": { status: "failed" },
        "retrospective": { status: "skipped" },
      },
    };
    const path = join(dir, "multi.lock");
    writeStateFile(path, state);
    const read = readStateFile(path);
    expect(read!.steps["daily-summary"]?.duration).toBe(12.5);
    expect(read!.steps["daily-summary"]?.attempts).toBe(2);
    expect(read!.steps["extract-memories"]?.status).toBe("failed");
    expect(read!.steps["retrospective"]?.status).toBe("skipped");
  });
});
