import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { tmpdir as osTmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { ensureInitialized } from "./ensure-initialized.js";

/**
 * ensure-initialized.test.ts — verify lazy-init seeds non-SOUL core files
 * and explicitly skips SOUL.md (which is owned by soul-seeder; #1323, #1324).
 *
 * We can't import ensure-initialized.ts directly because it resolves its
 * template dir via dirname(import.meta.url) at call time — pointing at the
 * real repo's templates/ tree. Instead we exercise the same path resolution
 * and file-copy logic by simulating the function locally. The actual
 * import-and-execute path is covered by the smoke test in cli-smoke.integration.test.ts.
 */

const TEMPLATE_BODY_SOUL = "I am <agentName>.\n";
const TEMPLATE_BODY_TOOLS = "# memory-tools\n";
const TEMPLATE_BODY_NOTES = "# agent_notes\n";

const LAZY_INIT_SKIP = new Set(["SOUL.md"]);

function ensureCoreFilesForTest(dataDir: string, tplDir: string): void {
  if (!existsSync(tplDir)) return;
  const coreDir = join(dataDir, "core");
  mkdirSync(coreDir, { recursive: true });
  for (const file of ["SOUL.md", "memory-tools.md", "agent_notes.md"]) {
    if (LAZY_INIT_SKIP.has(file)) continue;
    const dst = join(coreDir, file);
    if (!existsSync(dst)) {
      writeFileSync(dst, readFileSync(join(tplDir, file), "utf-8"));
    }
  }
}

function seedTemplates(tplDir: string): void {
  mkdirSync(tplDir, { recursive: true });
  writeFileSync(join(tplDir, "SOUL.md"), TEMPLATE_BODY_SOUL);
  writeFileSync(join(tplDir, "memory-tools.md"), TEMPLATE_BODY_TOOLS);
  writeFileSync(join(tplDir, "agent_notes.md"), TEMPLATE_BODY_NOTES);
}

describe("ensure-initialized core-file seed (#1323, #1324)", () => {
  let tplDir: string;
  let dataDir: string;

  beforeEach(() => {
    tplDir = mkdtempSync(join(osTmpdir(), "abmind-ensure-tpl-"));
    dataDir = mkdtempSync(join(osTmpdir(), "abmind-ensure-data-"));
    seedTemplates(tplDir);
  });

  afterEach(() => {
    rmSync(tplDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("seeds memory-tools.md and agent_notes.md when missing", () => {
    ensureCoreFilesForTest(dataDir, tplDir);
    expect(existsSync(join(dataDir, "core", "memory-tools.md"))).toBe(true);
    expect(existsSync(join(dataDir, "core", "agent_notes.md"))).toBe(true);
  });

  it("does NOT seed SOUL.md — owned by soul-seeder", () => {
    ensureCoreFilesForTest(dataDir, tplDir);
    expect(existsSync(join(dataDir, "core", "SOUL.md"))).toBe(false);
  });

  it("does not overwrite an existing memory-tools.md (idempotent)", () => {
    mkdirSync(join(dataDir, "core"), { recursive: true });
    const userContent = "# user's own\n";
    writeFileSync(join(dataDir, "core", "memory-tools.md"), userContent);

    ensureCoreFilesForTest(dataDir, tplDir);

    expect(readFileSync(join(dataDir, "core", "memory-tools.md"), "utf-8")).toBe(userContent);
  });

  it("is a no-op when template dir is missing", () => {
    rmSync(tplDir, { recursive: true, force: true });
    ensureCoreFilesForTest(dataDir, tplDir);
    expect(existsSync(join(dataDir, "core"))).toBe(false);
  });
});

describe("ensure-initialized path resolution (templates/memory/core)", () => {
  it("resolves to templates/memory/core — not the legacy templates/core", () => {
    // Test file lives at src/ensure-initialized.test.ts; the source we want
    // to inspect is one level up at the same basename.
    const here = dirname(fileURLToPath(import.meta.url));
    const srcPath = join(here, "ensure-initialized.ts");
    const src = readFileSync(srcPath, "utf-8");
    // The post-#1323 templatesDir() must reference templates/memory/core
    expect(src).toContain('join(here, "..", "templates", "memory", "core")');
    // And must NOT reference the legacy templates/core
    expect(src).not.toMatch(/join\(here, ["']\.\.["'], ["']templates["'], ["']core["']\)/);
  });
});

describe("ensure-initialized schema repair (#1513)", () => {
  it("repairs a schema_version=5 database missing semantic_revision", () => {
    const dataDir = mkdtempSync(join(osTmpdir(), "abmind-ensure-data-"));
    const dbPath = join(dataDir, "memory.db");
    const db = new Database(dbPath);

    try {
      db.exec(`
        CREATE TABLE extracted_memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content_en TEXT NOT NULL
        );
        INSERT INTO extracted_memories (content_en) VALUES ('existing memory');
        CREATE TABLE _meta (key TEXT PRIMARY KEY, value);
        INSERT INTO _meta (key, value) VALUES ('schema_version', '5');
      `);

      ensureInitialized(db, dataDir);

      const columns = db.prepare("PRAGMA table_info(extracted_memories)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "semantic_revision")).toBe(true);
      expect(db.prepare("SELECT semantic_revision FROM extracted_memories WHERE id = 1").get()).toEqual({ semantic_revision: 1 });
      expect(db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get()).toEqual({ value: "10" });

      expect(() => ensureInitialized(db, dataDir)).not.toThrow();
      expect(db.prepare("SELECT semantic_revision FROM extracted_memories WHERE id = 1").get()).toEqual({ semantic_revision: 1 });
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});


describe("#1658 legacy entity_graph guard (migration removed after both hosts migrated)", () => {
  it("initializeDatabase never throws on a pre-#1658 entity_graph table", async () => {
    const dataDir = mkdtempSync(join(osTmpdir(), "abmind-eg-guard-"));
    const dbPath = join(dataDir, "memory.db");
    const { initializeDatabase } = await import("./memory-db.js");

    // Legacy shape: replace the fresh owner-scoped table with the old one.
    const seedDb = initializeDatabase(dbPath);
    seedDb.exec("DROP TABLE entity_graph");
    seedDb.exec(`CREATE TABLE entity_graph (
      id INTEGER PRIMARY KEY,
      entity_a TEXT NOT NULL,
      entity_b TEXT NOT NULL,
      relation TEXT NOT NULL,
      source_memory_id INTEGER,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      UNIQUE(entity_a, entity_b, relation)
    )`);
    seedDb.exec(`INSERT INTO entity_graph (entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at) VALUES ('a', 'b', 'r', 1, 1, 1)`);
    seedDb.close();

    // Must not throw "no such column: user_id" (the daemon crash on Molty).
    const db = initializeDatabase(dbPath);
    try {
      const cols = db.prepare("PRAGMA table_info(entity_graph)").all() as Array<{ name: string }>;
      // Guard skips owner-index creation on legacy tables — no crash.
      expect(cols.some((c) => c.name === "user_id")).toBe(false);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("fresh databases get the owner-scoped table and indexes", async () => {
    const dataDir = mkdtempSync(join(osTmpdir(), "abmind-eg-fresh-"));
    const dbPath = join(dataDir, "memory.db");
    const { initializeDatabase } = await import("./memory-db.js");
    const db = initializeDatabase(dbPath);
    try {
      const cols = db.prepare("PRAGMA table_info(entity_graph)").all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === "user_id")).toBe(true);
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_eg_%'").all() as Array<{ name: string }>;
      expect(indexes.map((i) => i.name).sort()).toEqual(["idx_eg_owner_a", "idx_eg_owner_b"]);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
