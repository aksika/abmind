#!/usr/bin/env node
/**
 * abmind doctor — health check CLI (#442, #780).
 * Checks permissions, DB, ollama, templates, encryption, FTS, embeddings.
 * --fix auto-corrects what it can.
 * --quiet suppresses OK/SKIP lines.
 * --json outputs machine-readable JSON.
 */

import { existsSync, statSync, readdirSync, accessSync, constants, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

import { requireNativeDep } from "./lib/native-dep.js";

const _require = createRequire(import.meta.url);

const home = process.env.ABMIND_HOME ?? join(homedir(), ".abmind");
const abtarsHome = process.env.ABTARS_HOME ?? join(homedir(), ".abtars");
const argv = process.argv.slice(2);
const fix = argv.includes("--fix");
const quiet = argv.includes("--quiet");
const json = argv.includes("--json");

/** Resolve better-sqlite3 from the shared location (~/.local/lib/node_modules/).
 *  Falls back to standard resolution if the shared install is missing. */
function requireSqlite(): any {
  return requireNativeDep("better-sqlite3");
}

type Status = "ok" | "warn" | "error" | "skip";
type CheckResult = { name: string; status: Status; message: string };

const results: CheckResult[] = [];

function check(name: string, fn: () => { status: Status; message: string; fix?: () => void }): void {
  try {
    const r = fn();
    results.push({ name, status: r.status, message: r.message });
    if (!json) {
      if (quiet && (r.status === "ok" || r.status === "skip")) return;
      const icon = r.status === "ok" ? "[OK]  " : r.status === "warn" ? "[WARN]" : r.status === "skip" ? "[SKIP]" : "[ERR] ";
      process.stdout.write(`${icon} ${name}: ${r.message}\n`);
    }
    if (fix && r.fix && (r.status === "warn" || r.status === "error")) {
      r.fix();
      if (!json) process.stdout.write(`[FIX]  ${name} → corrected\n`);
    }
  } catch (err) {
    results.push({ name, status: "error", message: String(err) });
    if (!json) process.stdout.write(`[ERR]  ${name}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

function checkDirMode(path: string, expected: number): { status: Status; message: string; fix?: () => void } {
  if (!existsSync(path)) return { status: "warn", message: "missing", fix: () => mkdirSync(path, { recursive: true, mode: expected }) };
  const mode = statSync(path).mode & 0o777;
  if (mode === expected) return { status: "ok", message: `${path} (${mode.toString(8)})` };
  return { status: "warn", message: `${mode.toString(8)} — should be ${expected.toString(8)}`, fix: () => chmodSync(path, expected) };
}

function checkFilesMode(dir: string, expected: number): { status: Status; message: string; fix?: () => void } {
  if (!existsSync(dir)) return { status: "skip", message: "dir missing" };
  const bad: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isFile() && (st.mode & 0o777) !== expected) bad.push(f);
  }
  if (bad.length === 0) return { status: "ok", message: `all files ${expected.toString(8)}` };
  return {
    status: "warn",
    message: `${bad.length} file(s) not ${expected.toString(8)}: ${bad.slice(0, 3).join(", ")}`,
    fix: () => { for (const f of bad) chmodSync(join(dir, f), expected); },
  };
}

// ── Checks ──────────────────────────────────────────────────────────────────

const doctorVersion = (() => {
  try {
    const { fileURLToPath } = _require("url");
    const thisDir = join(fileURLToPath(import.meta.url), "..");
    const repoRoot = join(thisDir, "..", "..");
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
    const { spawnSync } = _require("child_process");
    const r = spawnSync("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], { encoding: "utf-8", timeout: 3000 });
    const sha = r.status === 0 ? `-${r.stdout.trim()}` : "";
    return `${pkg.version}${sha}`;
  } catch { return "unknown"; }
})();

if (!json) {
  const { printBanner } = await import("./banner.js");
  await printBanner("doctor");
}

// Permissions
check("root ~/.abmind/", () => checkDirMode(home, 0o700));
check("config/ permissions", () => checkDirMode(join(home, "config"), 0o700));
check("config/* files", () => checkFilesMode(join(home, "config"), 0o600));
check("memory/ permissions", () => checkDirMode(join(home, "memory"), 0o700));
check("secret/ permissions", () => checkDirMode(join(home, "secret"), 0o700));
check("secret/* files", () => checkFilesMode(join(home, "secret"), 0o600));

// Key files
check("encryption key", () => {
  const keyFile = join(home, "secret", "abmind.key");
  const verifyFile = join(home, "secret", "key.verify");
  if (!existsSync(keyFile) && !existsSync(verifyFile)) return { status: "warn", message: "no key file — secrets not encrypted" };
  if (existsSync(keyFile) && !existsSync(verifyFile)) {
    return {
      status: "warn",
      message: "abmind.key exists but key.verify missing",
      fix: () => {
        const { loadKeyFromFile, writeKeyVerify } = require("../src/crypto.js");
        writeKeyVerify(loadKeyFromFile(keyFile));
      },
    };
  }
  return { status: "ok", message: "key + verify present" };
});

// Memory DB
check("memory.db exists", () => {
  const p = join(home, "memory", "memory.db");
  return existsSync(p) ? { status: "ok", message: p } : { status: "warn", message: "missing — run abmind install" };
});

// Schema version
check("schema version", () => {
  const dbPath = join(home, "memory", "memory.db");
  if (!existsSync(dbPath)) return { status: "skip", message: "no DB" };
  try {
    const Database = requireSqlite();
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as { version: number } | undefined;
    db.close();
    if (!row) return { status: "warn", message: "no schema_version table" };
    return { status: "ok", message: `v${row.version}` };
  } catch (err: any) {
    if (err?.message?.includes("no such table")) return { status: "ok", message: "no schema tracking (managed by MemoryManager)" };
    return { status: "skip", message: err?.message ?? "cannot open DB" };
  }
});

// FTS integrity
check("FTS integrity", () => {
  const dbPath = join(home, "memory", "memory.db");
  if (!existsSync(dbPath)) return { status: "skip", message: "no DB" };
  try {
    const Database = requireSqlite();
    const db = new Database(dbPath, { readonly: false });
    const tables = ["extracted_memories_fts", "content_en_trigram", "content_original_trigram"];
    const corrupt: string[] = [];
    const missing: string[] = [];
    for (const t of tables) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
      if (!exists) { missing.push(t); continue; }
      try { db.exec(`INSERT INTO ${t}(${t}) VALUES('integrity-check')`); }
      catch { corrupt.push(t); }
    }
    if (corrupt.length === 0 && missing.length === 0) { db.close(); return { status: "ok", message: `${tables.length} FTS tables healthy` }; }
    db.close();
    return {
      status: "warn",
      message: `${corrupt.length} corrupt: ${corrupt.join(", ") || "none"}; ${missing.length} missing: ${missing.join(", ") || "none"}`,
      fix: () => {
        const db2 = new Database(dbPath, { readonly: false });
        for (const t of corrupt) {
          try { db2.exec(`INSERT INTO ${t}(${t}) VALUES('rebuild')`); } catch { /* best effort */ }
        }
        db2.close();
      },
    };
  } catch (err: any) { return { status: "skip", message: err?.message ?? "cannot open DB" }; }
});

// WAL size
check("WAL size", () => {
  const walPath = join(home, "memory", "memory.db-wal");
  if (!existsSync(walPath)) return { status: "ok", message: "no WAL" };
  const size = statSync(walPath).size;
  if (size < 10 * 1024 * 1024) return { status: "ok", message: `${(size / 1024).toFixed(0)}KB` };
  return {
    status: "warn",
    message: `${(size / 1024 / 1024).toFixed(1)}MB (>10MB)`,
    fix: () => {
      const Database = requireSqlite();
      const db = new Database(join(home, "memory", "memory.db"));
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
    },
  };
});

// Embedding gaps
check("embedding gaps", () => {
  const dbPath = join(home, "memory", "memory.db");
  if (!existsSync(dbPath)) return { status: "skip", message: "no DB" };
  try {
    const Database = requireSqlite();
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT COUNT(*) as cnt FROM extracted_memories WHERE embedding IS NULL").get() as { cnt: number };
    db.close();
    if (row.cnt === 0) return { status: "ok", message: "all embedded" };
    // Check if embedding is explicitly disabled (env OR ~/.abmind/config/.env.memory)
    let embeddingDisabled = (process.env["EMBEDDING_ENABLED"] ?? "").toLowerCase() === "false";
    if (!embeddingDisabled) {
      const envMemory = join(home, "config", ".env.memory");
      if (existsSync(envMemory)) {
        const content = readFileSync(envMemory, "utf-8");
        embeddingDisabled = /^\s*EMBEDDING_ENABLED\s*=\s*false\s*$/m.test(content);
      }
    }
    if (embeddingDisabled) return { status: "warn", message: `${row.cnt} without embeddings (explicitly disabled — recommend enabling: set EMBEDDING_ENABLED=true)` };
    return {
      status: "warn",
      message: `${row.cnt} memories without embeddings`,
      fix: () => {
        const { spawnSync: spawn } = _require("child_process");
        // Native deps (better-sqlite3) only resolve from source tree (ESM ignores NODE_PATH)
        // #1308: abmind owns its dev source at ~/.abmind/src/abmind.
        const srcEmbed = join(home, "src", "abmind", "dist", "cli", "abmind-embed.js");
        const { fileURLToPath } = _require("url");
        const bundleEmbed = join(fileURLToPath(import.meta.url), "..", "abmind-embed.js");
        const embedJs = existsSync(srcEmbed) ? srcEmbed : bundleEmbed;
        const r = spawn(process.execPath, [embedJs], {
          env: { ...process.env, ABMIND_HOME: home, EMBEDDING_ENABLED: "true" },
          stdio: "pipe",
          timeout: 300_000,
        });
        if (r.status === 0) process.stdout.write(`[FIX]  embedded ${row.cnt} memories\n`);
        else process.stdout.write(`[FIX]  embed failed: ${(r.stderr?.toString() ?? "").slice(0, 200)}\n`);
      },
    };
  } catch (err: any) { return { status: "skip", message: err?.message ?? "cannot open DB" }; }
});

// Embedding integrity — detect corrupted BLOBs (wrong size, NaN)
check("embedding integrity", () => {
  const dbPath = join(home, "memory", "memory.db");
  if (!existsSync(dbPath)) return { status: "skip", message: "no DB" };
  try {
    const Database = requireSqlite();
    const db = new Database(dbPath, { readonly: true });
    const dims = 768;
    const expectedFloat32 = dims * 4;
    const expectedInt8 = dims;
    const rows = db.prepare("SELECT id, length(embedding) as len FROM extracted_memories WHERE embedding IS NOT NULL LIMIT 200").all() as Array<{ id: number; len: number }>;
    const corrupted: number[] = [];
    for (const r of rows) {
      if (r.len !== expectedFloat32 && r.len !== expectedInt8) corrupted.push(r.id);
    }
    // Sample first 10 float32 embeddings for NaN
    const samples = db.prepare(`SELECT id, embedding FROM extracted_memories WHERE embedding IS NOT NULL AND length(embedding) = ${expectedFloat32} LIMIT 10`).all() as Array<{ id: number; embedding: Buffer }>;
    for (const s of samples) {
      const view = new DataView(new Uint8Array(s.embedding).buffer);
      for (let i = 0; i < dims; i++) { if (isNaN(view.getFloat32(i * 4, true))) { corrupted.push(s.id); break; } }
    }
    db.close();
    if (corrupted.length === 0) return { status: "ok", message: `${rows.length} checked, all valid` };
    if (fix) {
      const dbW = new Database(dbPath);
      const stmt = dbW.prepare("UPDATE extracted_memories SET embedding = NULL WHERE id = ?");
      for (const id of corrupted) stmt.run(id);
      dbW.close();
      return { status: "ok", message: `fixed ${corrupted.length} corrupted embeddings (nulled for re-embed)` };
    }
    return { status: "warn", message: `${corrupted.length} corrupted embeddings (ids: ${corrupted.slice(0, 5).join(",")}) — run with --fix` };
  } catch (err: any) { return { status: "skip", message: err?.message ?? "cannot open DB" }; }
});

// Memory count sanity
check("memory count", () => {
  const dbPath = join(home, "memory", "memory.db");
  if (!existsSync(dbPath)) return { status: "skip", message: "no DB" };
  try {
    const Database = requireSqlite();
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT COUNT(*) as cnt FROM extracted_memories").get() as { cnt: number };
    db.close();
    if (row.cnt > 0) return { status: "ok", message: `${row.cnt} memories` };
    // Check install age
    const manifestPath = join(home, "manifest.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const installedAt = new Date(manifest.activatedAt ?? manifest.installedAt ?? 0).getTime();
      if (Date.now() - installedAt > 86400000) return { status: "warn", message: "0 memories — install >24h old, extraction may not be working" };
    }
    return { status: "ok", message: "0 memories (fresh install)" };
  } catch (err: any) { return { status: "skip", message: err?.message ?? "cannot open DB" }; }
});

// Daily file freshness
check("daily freshness", () => {
  const dailyDir = join(home, "memory", "daily");
  if (!existsSync(dailyDir)) return { status: "skip", message: "no daily/ dir" };
  const files = readdirSync(dailyDir).filter(f => f.startsWith("daily_")).sort().reverse();
  if (files.length === 0) return { status: "warn", message: "no daily files" };
  const latest = files[0]!;
  const match = latest.match(/daily_(\d{4}-\d{2}-\d{2})/);
  if (!match) return { status: "ok", message: `${files.length} files` };
  const age = Math.round((Date.now() - new Date(match[1]!).getTime()) / 86400000);
  if (age > 3) return { status: "warn", message: `latest is ${age}d old (${latest}) — sleep may not be running` };
  return { status: "ok", message: `${files.length} files, latest ${age}d old` };
});

// encryptionUser mismatch
check("encryptionUser", () => {
  const manifestPath = join(home, "manifest.json");
  if (!existsSync(manifestPath)) return { status: "skip", message: "no manifest" };
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (!manifest.encryptionUser) return { status: "warn", message: "encryptionUser missing — re-run abmind install or set manually in manifest.json" };
    return { status: "ok", message: manifest.encryptionUser };
  } catch { return { status: "skip", message: "cannot read manifest" }; }
});

// Core templates
check("core templates", () => {
  const coreDir = join(home, "memory", "core");
  if (!existsSync(coreDir)) return { status: "warn", message: "missing — run abmind install" };
  const files = readdirSync(coreDir).filter(f => f.endsWith(".md"));
  return files.length >= 4
    ? { status: "ok", message: `${files.length} templates` }
    : { status: "warn", message: `only ${files.length} templates (expected ≥4)` };
});

// logs/ writable
check("logs/ writable", () => {
  const logsDir = join(home, "logs");
  if (!existsSync(logsDir)) return { status: "warn", message: "missing", fix: () => mkdirSync(logsDir, { recursive: true, mode: 0o700 }) };
  try { accessSync(logsDir, constants.W_OK); return { status: "ok", message: "writable" }; }
  catch { return { status: "warn", message: "not writable" }; }
});

// ollama reachable
check("ollama reachable", () => {
  const { execSync } = _require("child_process");
  try {
    execSync("command -v ollama", { timeout: 3000, stdio: "pipe", shell: true });
  } catch { return { status: "warn", message: "ollama not installed" }; }
  try {
    execSync("curl -sf http://localhost:11434/api/tags", { timeout: 3000, stdio: "pipe" });
    return { status: "ok", message: "localhost:11434" };
  } catch { return { status: "warn", message: "installed but not running" }; }
});

// embedding model
check("embedding model", () => {
  try {
    const { execSync, spawnSync } = _require("child_process");
    const out = execSync("curl -sf http://localhost:11434/api/tags", { timeout: 3000, encoding: "utf-8" });
    const models = JSON.parse(out).models?.map((m: any) => m.name) ?? [];
    const has = models.some((n: string) => n.includes("nomic-embed-text"));
    if (has) return { status: "ok", message: "nomic-embed-text" };
    return {
      status: "warn",
      message: `not found (available: ${models.slice(0, 3).join(", ")})`,
      fix: () => {
        const r = spawnSync("ollama", ["pull", "nomic-embed-text"], { stdio: "pipe", timeout: 120_000 });
        if (r.status === 0) process.stdout.write(`[FIX]  pulled nomic-embed-text\n`);
        else process.stdout.write(`[FIX]  ollama pull failed: ${(r.stderr?.toString() ?? "").slice(0, 100)}\n`);
      },
    };
  } catch { return { status: "skip", message: "ollama not reachable" }; }
});

// sqlite-vec (post-#1204: lives in unified ~/.local/lib/node_modules/)
check("sqlite-vec", () => {
  const vecPath = join(homedir(), ".local", "lib", "node_modules", "sqlite-vec");
  if (existsSync(vecPath)) return { status: "ok", message: "loadable" };
  return { status: "warn", message: "not installed (brute-force fallback) — run: abmind deps install" };
});

// IPC socket
check("IPC socket", () => {
  const sock = join(home, "memory.sock");
  if (!existsSync(sock)) return { status: "skip", message: "not running (bridge offline)" };
  return { status: "ok", message: sock };
});

// Sleep health
check("sleep health", () => {
  const dbPath = join(home, "memory", "memory.db");
  if (!existsSync(dbPath)) return { status: "skip", message: "no DB" };
  try {
    const Database = requireSqlite();
    const db = new Database(dbPath, { readonly: true });
    const get = (key: string): string | null => {
      const row = db.prepare("SELECT value FROM _meta WHERE key = ?").get(key) as { value: string } | undefined;
      return row?.value ?? null;
    };
    const lastSuccess = get("sleep_last_success_ts");
    const failures = parseInt(get("sleep_consecutive_failures") ?? "0", 10);
    db.close();
    if (failures > 3) return { status: "warn", message: `${failures} consecutive failures` };
    if (lastSuccess) {
      const ageH = Math.round((Date.now() - parseInt(lastSuccess, 10)) / 3600000);
      if (ageH > 48) return { status: "warn", message: `last success ${ageH}h ago (>48h)` };
      return { status: "ok", message: `last success ${ageH}h ago, ${failures} failures` };
    }
    return { status: "skip", message: "no sleep runs recorded yet" };
  } catch { return { status: "skip", message: "cannot read _meta" }; }
});

// Backup age
check("backup age", () => {
  const dbPath = join(home, "memory", "memory.db");
  if (!existsSync(dbPath)) return { status: "skip", message: "no DB" };
  try {
    const Database = requireSqlite();
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT value FROM _meta WHERE key = 'last_backup_ts'").get() as { value: string } | undefined;
    db.close();
    if (!row) return { status: "warn", message: "no backup recorded" };
    const ageD = Math.round((Date.now() - parseInt(row.value, 10)) / 86400000);
    if (ageD > 7) return { status: "warn", message: `last backup ${ageD} days ago (>7d)` };
    return { status: "ok", message: `last backup ${ageD}d ago` };
  } catch { return { status: "skip", message: "cannot read _meta" }; }
});

// ── Summary ─────────────────────────────────────────────────────────────────

const ok = results.filter(r => r.status === "ok").length;
const warn = results.filter(r => r.status === "warn").length;
const err = results.filter(r => r.status === "error").length;

if (json) {
  const normalize = (s: Status): string => s === "ok" ? "ok" : s === "skip" ? "skipped" : "failed";
  process.stdout.write(JSON.stringify({ checks: results.map(r => ({ name: r.name, status: normalize(r.status), message: r.message })), summary: { ok, warn, error: err } }) + "\n");
} else {
  process.stdout.write(`\n${ok} passed, ${warn} warnings, ${err} errors\n`);
}

process.exit(err > 0 ? 2 : warn > 0 ? 1 : 0);
