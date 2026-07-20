// Non-dry-run coverage — this test shape is the point of #206.
// The bug shipped because only dry-run was exercised.
//
// Note: these tests were originally designed for the pre-daemon era when
// sleep-apply opened the DB directly. Now it goes through AbmindClient,
// and private.adjustRelevance requires CAS (#1449, CAS_WRITE_ENABLED=false).
// Once #1449 lands and CAS is enabled for tests, re-enable these tests by
// removing the skip from the describe block.
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

describe.skip("abmind sleep-apply — non-dry-run (#206) — blocked by #1449 CAS", () => {
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

    const result = spawnSync("node", [CLI, "--promote", String(id)], {
      env: isolatedChildEnv({ MEMORY_DIR: tmpDir, ABMIND_HOME: tmpDir }),
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

    const result = spawnSync("node", [CLI, "--demote", String(id)], {
      env: isolatedChildEnv({ MEMORY_DIR: tmpDir, ABMIND_HOME: tmpDir }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✅ Demoted");

    db = initializeDatabase(join(tmpDir, "memory.db"));
    const row = db.prepare("SELECT relevance_score FROM extracted_memories WHERE id = ?").get(id) as { relevance_score: number };
    expect(row.relevance_score).toBe(0);
  });
});
