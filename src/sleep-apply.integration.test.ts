// Non-dry-run coverage — this test shape is the point of #206.
// The bug shipped because only dry-run was exercised.
//
// The write path now goes through the owner-bound revision-CAS contract.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeDatabase } from "./memory-db.js";
import { isolatedChildEnv } from "./test-support/runtime-isolation.js";
import type Database from "better-sqlite3";

const CLI = resolve(__dirname, "../dist/cli/abmind-sleep-apply.js");

function seedMemory(db: Database.Database, relevanceScore: number): number {
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO extracted_memories (user_id, content_en, content_original, memory_type, relevance_score, confidence, source_timestamp, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("aksika", "test memory", "test memory", "fact", relevanceScore, 5, now, now);
  return Number(info.lastInsertRowid);
}

/*
 * TEST DEFICIENCY (2026-07-30):
 * Missing: non-dry-run CLI verification through a live abmind owner.
 * Reason deferred: this suite runs without starting the daemon, while the
 * production CLI intentionally refuses to open a second SQLite owner.
 * Future verification: run the same two commands against a disposable daemon
 * and assert the revision-CAS result and database state.
 */
describe.skip("abmind sleep-apply — non-dry-run (#206) — requires live daemon", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sleep-apply-test-"));
    db = initializeDatabase(join(tmpDir, "memory.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("--promote: bumps relevance_score by +10", () => {
    const id = seedMemory(db, 0);
    db.close();

    const result = spawnSync("node", [CLI, "--promote", String(id), "--expected-revision", "1"], {
      env: isolatedChildEnv({ MEMORY_DIR: tmpDir, ABMIND_HOME: tmpDir, ABMIND_USER_ID: "aksika" }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✅ Promoted");

    db = initializeDatabase(join(tmpDir, "memory.db"));
    const row = db.prepare("SELECT relevance_score FROM extracted_memories WHERE id = ?").get(id) as { relevance_score: number };
    expect(row.relevance_score).toBe(10);
  });

  it("--demote: drops relevance_score by -10", () => {
    const id = seedMemory(db, 10);
    db.close();

    const result = spawnSync("node", [CLI, "--demote", String(id), "--expected-revision", "1"], {
      env: isolatedChildEnv({ MEMORY_DIR: tmpDir, ABMIND_HOME: tmpDir, ABMIND_USER_ID: "aksika" }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✅ Demoted");

    db = initializeDatabase(join(tmpDir, "memory.db"));
    const row = db.prepare("SELECT relevance_score FROM extracted_memories WHERE id = ?").get(id) as { relevance_score: number };
    expect(row.relevance_score).toBe(0);
  });
});
