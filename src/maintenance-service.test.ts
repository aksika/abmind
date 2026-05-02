import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";

describe("MaintenanceService.runPreSleepTasks", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "presleep-"));
    const memDir = join(tmpDir, "memory");
    mkdirSync(join(memDir, "sleep"), { recursive: true });
    manager = new MemoryManager(makeMemoryTestConfig(memDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs without errors on empty DB", async () => {
    const sleepData = manager.getSleepData();
    const r = await manager.maintenance.runPreSleepTasks(manager, sleepData);
    expect(r.walOk).toBe(true);
    expect(r.ftsOk).toBe(true);
    expect(r.purged).toBe(0);
    expect(r.deduped).toBe(0);
  });

  it("purges expired garbage entries", async () => {
    const memDir = join(tmpDir, "memory");
    // Record a message so we have something to purge
    manager.recordMessage({ role: "user", content: "test", timestamp: 1000, userId: "master", sessionId: "s1" });
    const msgId = (manager as unknown as { db: { prepare: (s: string) => { get: () => { id: number } } } }).db
      .prepare("SELECT id FROM messages ORDER BY id DESC LIMIT 1").get().id;

    // Write garbage.json with expired entry (>7 days old)
    const oldDate = new Date(Date.now() - 8 * 86400000).toISOString();
    writeFileSync(join(memDir, "garbage.json"), JSON.stringify({ [msgId]: oldDate }));

    const sleepData = manager.getSleepData();
    const r = await manager.maintenance.runPreSleepTasks(manager, sleepData);
    expect(r.purged).toBe(1);
  });

  it("deduplicates consecutive identical messages", async () => {
    manager.recordMessage({ role: "user", content: "hello", timestamp: 1000, userId: "master", sessionId: "s1" });
    manager.recordMessage({ role: "user", content: "hello", timestamp: 1001, userId: "master", sessionId: "s1" });

    const sleepData = manager.getSleepData();
    const r = await manager.maintenance.runPreSleepTasks(manager, sleepData);
    expect(r.deduped).toBe(1);
  });
});
