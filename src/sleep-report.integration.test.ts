// Non-dry-run coverage — sleep-report used to fail on 'no such column: importance'.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeDatabase } from "./memory-db.js";
import { isolatedChildEnv } from "./test-support/runtime-isolation.js";
import type Database from "better-sqlite3";

const CLI = resolve(__dirname, "../dist/cli/abmind-sleep-report.js");

describe("abmind sleep-report — non-dry-run (#206)", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sleep-report-test-"));
    db = initializeDatabase(join(tmpDir, "memory.db"));
    const now = Date.now();
    db.prepare(
      `INSERT INTO long_term_memories (user_id, memory_type, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("aksika", "fact", "boosted fact", now, now);
    db.prepare(
      `INSERT INTO long_term_memories (user_id, memory_type, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("aksika", "fact", "neutral fact", now, now);
    db.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits 0 and reports durable counts", () => {
    const result = spawnSync("node", [CLI], {
      env: isolatedChildEnv({ MEMORY_DIR: tmpDir, ABMIND_HOME: tmpDir }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Total durables: 2");
    expect(result.stdout).toContain("boosted fact");
    expect(result.stdout).toContain("rev=1");
    expect(result.stdout).not.toContain("rel=");
    expect(result.stderr).not.toMatch(/no such column|no such table/i);
  });
});
