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

describe("ensure-initialized schema repair (#1513, #1939 stage 3)", () => {
  it("heals a schema_version=5 database: repair chain runs, then the legacy table drops", () => {
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

      // The repair chain runs without throwing on the legacy table (the
      // semantic_revision repair applies mid-chain), then #1939 drops it.
      expect(() => ensureInitialized(db, dataDir)).not.toThrow();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'extracted_memories'").get()).toBeUndefined();
      expect(db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get()).toEqual({ value: "14" });

      expect(() => ensureInitialized(db, dataDir)).not.toThrow();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'extracted_memories'").get()).toBeUndefined();
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("#1659 regression: heals a version-10 database whose ledger CHECK lacks 'in_flight'", () => {
    const dataDir = mkdtempSync(join(osTmpdir(), "abmind-ensure-data-"));
    const dbPath = join(dataDir, "memory.db");
    const db = new Database(dbPath);

    try {
      // The exact production shape: schema_version already at the old list
      // length and the ledger table with the pre-#1659 CHECK constraint.
      db.exec(`
        CREATE TABLE abmind_service_requests (
          principal_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          method TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('reserved','dispatch_started','completed','outcome_unknown')),
          response_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (principal_id, idempotency_key)
        );
        INSERT INTO abmind_service_requests (principal_id, idempotency_key, method, payload_hash, state, response_json, created_at, updated_at)
          VALUES ('local-user', 'k1', 'private.recordMessage', 'h', 'completed', '{"ok":true}', 1, 1);
        CREATE TABLE _meta (key TEXT PRIMARY KEY, value);
        INSERT INTO _meta (key, value) VALUES ('schema_version', '10');
      `);

      ensureInitialized(db, dataDir);

      const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='abmind_service_requests'").get() as { sql: string }).sql;
      expect(sql).toContain("'in_flight'");
      const row = db.prepare("SELECT * FROM abmind_service_requests WHERE idempotency_key = 'k1'").get() as { state: string };
      expect(row.state).toBe("completed");
      expect(db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get()).toEqual({ value: "14" });
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("repairs a DQS legacy ledger before SQLite ALTER TABLE reparses it", () => {
    const dataDir = mkdtempSync(join(osTmpdir(), "abmind-ensure-data-"));
    const dbPath = join(dataDir, "memory.db");
    const db = new Database(dbPath);

    try {
      // better-sqlite3 disables double-quoted string literals when parsing
      // DDL, so seed a valid table and rewrite only sqlite_master to reproduce
      // the legacy production shape found on Molty.
      db.exec(`
        CREATE TABLE abmind_service_requests (
          principal_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          method TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('reserved','dispatch_started','in_flight','completed','outcome_unknown')),
          response_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (principal_id, idempotency_key)
        );
        INSERT INTO abmind_service_requests (principal_id, idempotency_key, method, payload_hash, state, response_json, created_at, updated_at)
          VALUES ('local-user', 'k-dqs', 'private.recordMessage', 'h', 'completed', '{"ok":true}', 1, 1);
        CREATE TABLE _meta (key TEXT PRIMARY KEY, value);
        INSERT INTO _meta (key, value) VALUES ('schema_version', '10');
      `);

      const row = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get("abmind_service_requests") as { sql: string };
      db.unsafeMode(true);
      try {
        db.pragma("writable_schema = ON");
        db.prepare(
          "UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = ?",
        ).run(row.sql.replaceAll("'", '"'), "abmind_service_requests");
        db.pragma("schema_version = 2");
      } finally {
        db.pragma("writable_schema = OFF");
        db.unsafeMode(false);
      }

      ensureInitialized(db, dataDir);

      const sql = (db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get("abmind_service_requests") as { sql: string }).sql;
      expect(sql).toContain("'in_flight'");
      expect(sql).not.toContain('"in_flight"');
      const rowAfter = db.prepare(
        "SELECT state FROM abmind_service_requests WHERE idempotency_key = ?",
      ).get("k-dqs") as { state: string };
      expect(rowAfter.state).toBe("completed");
      expect(db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get()).toEqual({ value: "14" });
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});


describe("#1939 stage 3: legacy tables are dropped (replaces the #1658 entity_graph guard)", () => {
  it("initializeDatabase drops surviving legacy tables without throwing", async () => {
    const dataDir = mkdtempSync(join(osTmpdir(), "abmind-eg-guard-"));
    const dbPath = join(dataDir, "memory.db");
    const { initializeDatabase } = await import("./memory-db.js");

    // Legacy shape: create the dropped tables by hand, then boot.
    const seedDb = initializeDatabase(dbPath);
    seedDb.exec(`CREATE TABLE extracted_memories (
      id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, content_en TEXT
    )`);
    seedDb.exec(`INSERT INTO extracted_memories (id, user_id, content_en) VALUES (1, 'u', 'old')`);
    seedDb.exec(`CREATE TABLE entity_graph (
      id INTEGER PRIMARY KEY,
      entity_a TEXT NOT NULL, entity_b TEXT NOT NULL, relation TEXT NOT NULL,
      source_memory_id INTEGER, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      UNIQUE(entity_a, entity_b, relation)
    )`);
    seedDb.exec(`INSERT INTO entity_graph (entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at) VALUES ('a', 'b', 'r', 1, 1, 1)`);
    seedDb.exec(`CREATE TABLE ingested_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, source_type TEXT NOT NULL,
      identifier TEXT NOT NULL, chunk_count INTEGER NOT NULL, ingested_at INTEGER NOT NULL
    )`);
    seedDb.close();

    // Must not throw; ensureInitialized runs the versioned migration chain,
    // whose #1939 entry drops the legacy tables.
    const { ensureInitialized } = await import("./ensure-initialized.js");
    const db = initializeDatabase(dbPath);
    ensureInitialized(db, dataDir);
    try {
      for (const name of ["extracted_memories", "extracted_memories_fts", "content_en_trigram", "content_original_trigram", "entity_graph", "ingested_documents", "vec_memories"]) {
        expect(db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(name), name).toBeUndefined();
      }
      // New-model tables are unaffected.
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'long_term_memories'").get()).toBeDefined();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'messages'").get()).toBeDefined();
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("fresh databases never create legacy tables", async () => {
    const dataDir = mkdtempSync(join(osTmpdir(), "abmind-eg-fresh-"));
    const dbPath = join(dataDir, "memory.db");
    const { initializeDatabase } = await import("./memory-db.js");
    const db = initializeDatabase(dbPath);
    try {
      for (const name of ["extracted_memories", "extracted_memories_fts", "content_en_trigram", "content_original_trigram", "entity_graph", "ingested_documents"]) {
        expect(db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(name), name).toBeUndefined();
      }
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
