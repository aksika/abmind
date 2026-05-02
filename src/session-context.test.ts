import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { buildSessionStartContext, RECENT_MSG_CAP } from "./session-context.js";

function insertMessage(manager: MemoryManager, role: string, content: string, timestamp: number): void {
  const db = manager.getDb()!;
  db.prepare(
    "INSERT INTO messages (role, content, timestamp, user_id, session_id) VALUES (?, ?, ?, 1, 's1')"
  ).run(role, content, timestamp);
}

function writeDaily(dir: string, date: string, content: string): void {
  const dailyDir = join(dir, "daily");
  mkdirSync(dailyDir, { recursive: true });
  writeFileSync(join(dailyDir, `daily_${date}.md`), content, "utf-8");
}

describe("buildSessionStartContext", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-ctx-"));
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when DB is empty (no daily, no messages)", () => {
    expect(buildSessionStartContext(manager, 1)).toBeNull();
  });

  it("returns daily summary when no newer messages exist", () => {
    const dailyContent = "# Daily Summary\n\nDiscussed memory refactor.";
    writeDaily(tmpDir, "2026-03-21", dailyContent);

    const result = buildSessionStartContext(manager, 1);

    expect(result).not.toBeNull();
    expect(result).toContain("[LAST SESSION SUMMARY — ended");
    expect(result).toContain("[SESSION START —");
    expect(result).toContain("Discussed memory refactor.");
  });

  it("returns recent messages when they are newer than the daily", () => {
    // Daily from yesterday
    writeDaily(tmpDir, "2026-03-21", "# Old daily");

    // Messages newer than the daily file
    const now = Date.now();
    insertMessage(manager, "user", "Let's fix the cron bug", now - 5000);
    insertMessage(manager, "assistant", "Sure, looking at it now", now - 3000);
    insertMessage(manager, "user", "Check agentbridge-task.ts", now - 1000);

    const result = buildSessionStartContext(manager, 1);

    expect(result).not.toBeNull();
    expect(result).toContain("Let's fix the cron bug");
    expect(result).toContain("Check agentbridge-task.ts");
    expect(result).toContain("[LAST SESSION SUMMARY — ended");
    expect(result).toContain("[SESSION START —");
  });

  it("returns recent messages when no daily exists at all", () => {
    const now = Date.now();
    insertMessage(manager, "user", "Hello there", now - 2000);
    insertMessage(manager, "assistant", "Hi!", now - 1000);

    const result = buildSessionStartContext(manager, 1);

    expect(result).not.toBeNull();
    expect(result).toContain("Hello there");
    expect(result).toContain("Hi!");
  });

  it("injects full daily summary without truncation", () => {
    const longContent = "# Daily\n\n" + "x".repeat(3500);
    writeDaily(tmpDir, "2026-03-21", longContent);

    const result = buildSessionStartContext(manager, 1)!;
    expect(result).toContain("x".repeat(3500));
  });

  it("caps recent messages by dropping oldest first", () => {
    const now = Date.now();
    // Insert 12 long messages
    for (let i = 0; i < 12; i++) {
      insertMessage(manager, "user", "M" + i + " " + "A".repeat(400), now - (12 - i) * 1000);
    }

    const result = buildSessionStartContext(manager, 1)!;
    // Most recent message must be present
    expect(result).toContain("M11");
    // Total body should be under cap (with some slack for timestamps/markers)
    const body = result.split("\n").slice(1, -1).join("\n");
    expect(body.length).toBeLessThanOrEqual(RECENT_MSG_CAP + 200);
    // Oldest messages should be dropped
    expect(result).not.toContain("M0 ");
  });

  it("wraps output in REQ-4 temporal markers", () => {
    const now = Date.now();
    insertMessage(manager, "user", "test message", now - 1000);

    const result = buildSessionStartContext(manager, 1)!;
    const lines = result.split("\n");

    expect(lines[0]).toMatch(/^\[LAST SESSION SUMMARY — ended \d{4}-\d{2}-\d{2}[ T]/);
    expect(lines[lines.length - 1]).toMatch(/^\[SESSION START — \d{4}-\d{2}-\d{2}[ T]/);
  });
});
