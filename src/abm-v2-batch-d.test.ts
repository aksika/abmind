import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager, getMemoryDb } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { buildWakeUp } from "./wake-up-builder.js";

describe("wake-up-builder", () => {
  let tmpDir: string;
  let mm: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "abm-wakeup-"));
    process.env["ABMIND_HOME"] = tmpDir;
    mm = new MemoryManager(makeMemoryTestConfig(join(tmpDir, "memory")));
    await mm.initialize({ skipEmbeddingCheck: true });
  });

  afterEach(() => {
    mm.close();
    delete process.env["ABMIND_HOME"];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty for null db", () => {
    expect(buildWakeUp(null)).toBe("");
  });

  it("includes current time", () => {
    const result = buildWakeUp(getMemoryDb(mm)!);
    expect(result).toContain("[Current time:");
  });

  it("includes flashback when emotional memories exist", async () => {
    await mm.editor.instantStore({
      userId: "user-1", contentEn: "Amazing breakthrough on the project",
      contentOriginal: "test", memoryType: "event", emotionScore: 4, topic: "coding",
    });

    const result = buildWakeUp(getMemoryDb(mm)!);
    expect(result).toContain("[Flashback]");
  });

  it("no flashback when no emotional memories", () => {
    const result = buildWakeUp(getMemoryDb(mm)!);
    expect(result).not.toContain("[Flashback]");
    expect(result).toContain("[Current time:");
  });

  it("obeys strict maxChars bound with emotional memory via direct builder", async () => {
    await mm.editor.instantStore({
      userId: "user-1", contentEn: "Amazing breakthrough on the project",
      contentOriginal: "test", memoryType: "event", emotionScore: 4, topic: "coding",
    });

    const small = buildWakeUp(getMemoryDb(mm)!, 10);
    expect(small.length).toBeLessThanOrEqual(10);
  });

  it("obeys strict maxChars bound via MemoryManager", async () => {
    await mm.editor.instantStore({
      userId: "user-1", contentEn: "Amazing breakthrough on the project",
      contentOriginal: "test", memoryType: "event", emotionScore: 4, topic: "coding",
    });

    const small = mm.buildWakeUp(10);
    expect(small.length).toBeLessThanOrEqual(10);
  });

  it("large budget retains flashback", async () => {
    await mm.editor.instantStore({
      userId: "user-1", contentEn: "Amazing breakthrough on the project",
      contentOriginal: "test", memoryType: "event", emotionScore: 4, topic: "coding",
    });

    const large = mm.buildWakeUp(2000);
    expect(large.length).toBeLessThanOrEqual(2000);
    expect(large).toContain("[Flashback]");
  });

  it("returns empty for zero budget", () => {
    const result = buildWakeUp(getMemoryDb(mm)!, 0);
    expect(result).toBe("");
  });

  it("returns empty for negative budget", () => {
    const result = buildWakeUp(getMemoryDb(mm)!, -1);
    expect(result).toBe("");
  });
});
