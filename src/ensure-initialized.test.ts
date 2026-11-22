import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { tmpdir as osTmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { requireNativeDep } from "../cli/lib/native-dep.js";
import { ensureInitialized, SCHEMA_VERSION } from "./ensure-initialized.js";
import { initializeDatabase } from "./memory-db.js";
import { getMemoryDb, MemoryManager } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { setPersonalState } from "./personal-schema.js";
import { storeDurable } from "./personal-durable.js";
import { buildRecallProjection } from "./recall-projection-build.js";
import { ownedRecall } from "./owned-recall.js";
import { OWNED_RECALL_CONTRACT } from "./owned-recall-contract.js";

let sqliteVecForTest: { load(target: Database.Database): void } | undefined;
try {
  sqliteVecForTest = requireNativeDep("sqlite-vec") as typeof sqliteVecForTest;
} catch {
  sqliteVecForTest = undefined;
}

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
      expect(db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get()).toEqual({ value: String(SCHEMA_VERSION) });

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
      expect(db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get()).toEqual({ value: String(SCHEMA_VERSION) });
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
      expect(db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get()).toEqual({ value: String(SCHEMA_VERSION) });
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

  it.skipIf(!sqliteVecForTest)("drops a surviving vec0 index even though sqlite-vec is not loaded at boot", async () => {
    const dataDir = mkdtempSync(join(osTmpdir(), "abmind-vec-drop-"));
    const dbPath = join(dataDir, "memory.db");
    const { initializeDatabase } = await import("./memory-db.js");

    const seedDb = initializeDatabase(dbPath);
    sqliteVecForTest!.load(seedDb);
    seedDb.exec("CREATE VIRTUAL TABLE vec_memories USING vec0(embedding float[4])");
    seedDb.close();

    const db = initializeDatabase(dbPath);
    ensureInitialized(db, dataDir);
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'vec_memories'").get()).toBeUndefined();
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
      for (const name of ["extracted_memories", "extracted_memories_fts", "content_en_trigram", "content_original_trigram", "entity_graph", "ingested_documents", "vec_memories"]) {
        expect(db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(name), name).toBeUndefined();
      }
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

const RECALL_PROJECTION_TABLES = [
  "recall_documents",
  "recall_fts",
  "recall_trigram_en",
  "recall_trigram_orig",
  "recall_vectors",
  "recall_graph_edges",
  "recall_projection_state",
] as const;

const PRE_FIX_SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "test-fixtures",
  "schema-v14.sql",
);

function seedPreFixDatabase(dataDir: string): Database.Database {
  const db = new Database(join(dataDir, "memory.db"));
  try {
    db.exec(readFileSync(PRE_FIX_SCHEMA_PATH, "utf-8"));
    // The frozen fixture is the schema Molty and KP actually have: chain
    // position 14, personal tables present, recall projection set absent.
    db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '14')").run();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'recall_documents'").get()).toBeUndefined();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function schemaShape(db: Database.Database): unknown {
  const tables = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string; sql: string | null }>;
  return {
    tables: tables.map((table) => ({
      name: table.name,
      sql: (table.sql ?? "").replace(/\s+/g, " ").trim(),
      columns: (db.prepare(`PRAGMA table_info(${quoteIdent(table.name)})`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>).map((column) => ({
        name: column.name,
        type: column.type,
        notnull: column.notnull,
        dflt_value: column.dflt_value,
        pk: column.pk,
      })),
    })),
    indexes: db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all(),
    triggers: db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all(),
  };
}

describe("recall projection schema repair (#1957)", () => {
  const OWNER = "repair-owner";

  it("upgrades a pre-fix database to the fresh schema, idempotently", () => {
    const upgradedDir = mkdtempSync(join(osTmpdir(), "abmind-recall-upgrade-"));
    const freshDir = mkdtempSync(join(osTmpdir(), "abmind-recall-fresh-"));
    const upgradedDb = seedPreFixDatabase(upgradedDir);
    const freshDb = initializeDatabase(join(freshDir, "memory.db"));
    try {
      ensureInitialized(freshDb, freshDir);
      ensureInitialized(upgradedDb, upgradedDir);

      for (const name of RECALL_PROJECTION_TABLES) {
        expect(upgradedDb.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(name), name).toBeTruthy();
      }
      expect(upgradedDb.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get())
        .toEqual({ value: String(SCHEMA_VERSION) });
      // The repaired database must reach full schema parity with a fresh one,
      // not merely a list of expected table names.
      expect(schemaShape(upgradedDb)).toEqual(schemaShape(freshDb));

      const afterFirstRun = schemaShape(upgradedDb);
      ensureInitialized(upgradedDb, upgradedDir);
      expect(schemaShape(upgradedDb)).toEqual(afterFirstRun);
    } finally {
      upgradedDb.close();
      freshDb.close();
      rmSync(upgradedDir, { recursive: true, force: true });
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it("builds and serves an owned recall after the repair", async () => {
    const dataDir = mkdtempSync(join(osTmpdir(), "abmind-recall-recovery-"));
    try {
      seedPreFixDatabase(dataDir).close();

      const mm = new MemoryManager(makeMemoryTestConfig(dataDir), { ownerSnapshot: OWNER });
      try {
        await mm.initialize({ skipEmbeddingCheck: true });
        const db = getMemoryDb(mm);
        if (!db) throw new Error("test database missing");
        setPersonalState(db, "ready", { reason: "recall repair test ready" });

        const content = "the harbor ferry departs at nine";
        const messageId = Number(db.prepare(
          "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 's1', 'user', ?, 1000)",
        ).run(OWNER, content).lastInsertRowid);
        const durable = storeDurable(db, {
          userId: OWNER,
          memoryType: "fact",
          content,
          authority: "user_statement",
          authorityBasis: "repair test",
          applicabilityScope: { scope: "general" },
          provenance: {},
          evidence: [{ kind: "user_message", ref: String(messageId), excerpt: content, classification: 1 }],
          actorId: "test",
        });

        const built = buildRecallProjection(db, OWNER, { verifiedBackup: true });
        expect(built.ok).toBe(true);
        expect(built.indexedDurables).toBe(1);

        const provider = vi.spyOn(mm, "getEmbeddingProvider").mockReturnValue(null);
        let packet: Awaited<ReturnType<typeof ownedRecall>>;
        try {
          packet = await ownedRecall(mm, {
            contract: OWNED_RECALL_CONTRACT,
            profile: "recall_normal",
            identity: { principal: OWNER },
            query: { text: "harbor ferry departs nine" },
          });
        } finally {
          provider.mockRestore();
        }
        expect(packet.status).toBe("evidence");
        expect(packet.items.length).toBeGreaterThan(0);
        expect(packet.items.some((item) =>
          item.ref.kind === "db" && item.ref.layer === "durable" && item.ref.recordId === durable.id,
        )).toBe(true);
      } finally {
        mm.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
