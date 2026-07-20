// #211 — every column referenced in raw SQL in src/ or cli/ must exist in the schema.
// Catches the #206 class of bug at commit time (SqliteError: no such column).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeDatabase } from "./memory-db.js";
import type Database from "better-sqlite3";

const ROOT = resolve(__dirname, "..");

// --- Extraction ---

type Ref = { file: string; table: string; column: string };

const SQL_KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE",
  "GROUP", "BY", "ORDER", "ASC", "DESC", "LIMIT", "OFFSET", "HAVING", "DISTINCT",
  "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "AS", "ON", "JOIN",
  "LEFT", "RIGHT", "INNER", "OUTER", "UNION", "CASE", "WHEN", "THEN", "ELSE", "END",
  "CAST", "COUNT", "MIN", "MAX", "AVG", "SUM", "SUBSTR", "COALESCE", "IFNULL",
]);

/** Strip aggregate wrapping + trailing aliases. Returns "" if the expression is an alias-only / literal. */
function cleanColumn(expr: string): string {
  let s = expr.trim();
  // Strip ' AS alias' and ' alias' after an aggregate/expr
  s = s.replace(/\s+as\s+[a-z_][a-z0-9_]*\s*$/i, "");
  // Peel aggregate: MIN(col) / MAX(col) / COUNT(col) / AVG(col) / SUM(col) / SUBSTR(col, …)
  const agg = s.match(/^(?:count|min|max|avg|sum|substr)\s*\(\s*(\*|[a-z_][a-z0-9_]*)/i);
  if (agg) s = agg[1] ?? "";
  // Strip table-qualifier (t.col → col)
  s = s.replace(/^[a-z_][a-z0-9_]*\./i, "");
  // Discard '*' and integer/literal
  if (s === "*" || /^[0-9]+$/.test(s) || /^['"]/.test(s)) return "";
  // Accept only bare identifier
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) return "";
  if (SQL_KEYWORDS.has(s.toUpperCase())) return "";
  return s;
}

/** Extract (table, column) refs from a single SQL string. Returns [] for shapes we don't try to parse. */
export function extractRefs(sql: string, file = ""): Ref[] {
  // Reject dynamic / non-consumer shapes up front
  if (sql.includes("${")) return [];
  const firstWord = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
  if (firstWord === "PRAGMA" || firstWord === "ALTER" || firstWord === "CREATE" ||
      firstWord === "DROP" || firstWord === "BEGIN" || firstWord === "COMMIT" ||
      firstWord === "ROLLBACK" || firstWord === "VACUUM" || firstWord === "REINDEX") {
    return [];
  }
  if (/sqlite_master|sqlite_sequence|schema_version/i.test(sql)) return [];

  const refs: Ref[] = [];

  // SELECT <cols> FROM <table>
  const sel = sql.match(/SELECT\s+(.+?)\s+FROM\s+([a-z_][a-z0-9_]*)/is);
  if (sel && sel[1] && sel[2]) {
    const table = sel[2];
    const cols = sel[1].split(",");
    for (const c of cols) {
      const col = cleanColumn(c);
      if (col) refs.push({ file, table, column: col });
    }
  }

  // INSERT INTO <table> (<cols>) VALUES
  const ins = sql.match(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([a-z_][a-z0-9_]*)\s*\(([^)]+)\)/is);
  if (ins && ins[1] && ins[2]) {
    const table = ins[1];
    for (const c of ins[2].split(",")) {
      const col = cleanColumn(c);
      if (col) refs.push({ file, table, column: col });
    }
  }

  // UPDATE <table> SET <col> = …, <col> = …
  const upd = sql.match(/UPDATE\s+([a-z_][a-z0-9_]*)\s+SET\s+(.+?)(?:\s+WHERE\s+|$)/is);
  if (upd && upd[1] && upd[2]) {
    const table = upd[1];
    for (const assign of upd[2].split(",")) {
      const left = assign.split("=")[0];
      if (!left) continue;
      const col = cleanColumn(left);
      if (col) refs.push({ file, table, column: col });
    }
  }

  // DELETE FROM <table> WHERE … — column checking via WHERE-clause scanning is
  // intentionally omitted: string literals ('user'), function names (ABS, COLLATE),
  // and aliases (GROUP BY cnt) produce more false positives than value.
  // The three shapes above already catch the #206 class (column in UPDATE SET /
  // INSERT cols / SELECT list against a nonexistent column).

  return refs;
}

/** Recurse src/ + cli/, pull out string/template-literal args to .prepare(/.exec(, dedup. */
function collectSqlFromCodebase(): Array<{ file: string; sql: string }> {
  const out: Array<{ file: string; sql: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const s = statSync(p);
      if (s.isDirectory()) {
        if (entry === "node_modules" || entry === "dist") continue;
        walk(p);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      // memory-db.ts is the schema source — skip (CREATE/ALTER etc. self-reference).
      if (p.endsWith(`${join("src", "memory-db.ts")}`)) continue;
      const text = readFileSync(p, "utf-8");
      // Match .prepare( "…" ) / .prepare( `…` ) / .exec( "…" ) / .exec( `…` )
      // Greedy-safe: simple string or simple template (no interpolation).
      const re = /\.(?:prepare|exec)\s*\(\s*(`[^`]*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const raw = m[1]!;
        const sql = raw.slice(1, -1);
        out.push({ file: p.replace(ROOT + "/", ""), sql });
      }
    }
  };
  walk(join(ROOT, "src"));
  walk(join(ROOT, "cli"));
  return out;
}

// --- Schema introspection ---

describe("schema coverage (#211)", () => {
  let tmpDir: string;
  let db: Database.Database;
  let schema: Map<string, Set<string>>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "schema-coverage-"));
    db = initializeDatabase(join(tmpDir, "memory.db"));
    schema = new Map();
    const tables = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as Array<{ name: string; sql: string | null }>;
    const META = new Set(["sqlite_master", "sqlite_sequence", "schema_version"]);
    for (const t of tables) {
      if (META.has(t.name)) continue;
      if (t.sql?.toUpperCase().includes("VIRTUAL TABLE")) continue;
      const cols = db.prepare(`PRAGMA table_info(${t.name})`).all() as Array<{ name: string }>;
      schema.set(t.name, new Set(cols.map(c => c.name)));
    }
  });

  afterAll(() => {
    db?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("discovers at least the known baseline of real tables", () => {
    expect(schema.size).toBeGreaterThanOrEqual(4);
    expect(schema.has("extracted_memories")).toBe(true);
    expect(schema.has("messages")).toBe(true);
    expect(schema.has("operational_lesson_drafts")).toBe(true);
    expect(schema.has("operational_memories")).toBe(true);
    expect(schema.has("operational_memory_versions")).toBe(true);
  });

  it("extractor flags a synthetic known-bad query (self-test)", () => {
    const refs = extractRefs("SELECT importance FROM extracted_memories");
    expect(refs.some(r => r.table === "extracted_memories" && r.column === "importance")).toBe(true);
  });

  it("every column referenced in raw SQL exists in the schema", () => {
    const sqls = collectSqlFromCodebase();
    const allRefs: Ref[] = [];
    for (const { file, sql } of sqls) {
      allRefs.push(...extractRefs(sql, file));
    }
    // De-dup for nicer failure output
    const seen = new Set<string>();
    const problems: string[] = [];
    for (const r of allRefs) {
      const key = `${r.file}::${r.table}.${r.column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cols = schema.get(r.table);
      if (!cols) continue; // Table not in schema (e.g. FTS, filtered above) — skip silently
      if (!cols.has(r.column)) {
        problems.push(`${r.file}: '${r.column}' not in ${r.table} (valid: ${[...cols].sort().join(", ")})`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});
