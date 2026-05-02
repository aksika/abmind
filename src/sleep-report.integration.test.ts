// Non-dry-run coverage — sleep-report used to fail on 'no such column: importance'.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeDatabase } from "./memory-db.js";
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
      `INSERT INTO extracted_memories (user_id, content_en, content_original, memory_type, relevance_score, confidence, source_timestamp, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("aksika", "boosted fact", "boosted fact", "fact", 10, 5, now, now);
    db.prepare(
      `INSERT INTO extracted_memories (user_id, content_en, content_original, memory_type, relevance_score, confidence, source_timestamp, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("aksika", "neutral fact", "neutral fact", "fact", 0, 5, now, now);
    db.close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits 0 and reports rel= marker + positive-relevance count", () => {
    const result = spawnSync("node", [CLI], {
      env: { ...process.env, MEMORY_DIR: tmpDir, ABMIND_HOME: tmpDir },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("rel=10");
    expect(result.stdout).toContain("With positive relevance: 1");
    expect(result.stdout).not.toContain("imp=");
    expect(result.stderr).not.toMatch(/no such column/i);
  });
});
