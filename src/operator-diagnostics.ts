import { existsSync, statSync, readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import type { DoctorCheckResult, DoctorRepairAction, DoctorRepairResult } from "./abmind-protocol.js";
import type { MemoryManager } from "./memory-manager.js";
import { getMemoryDb } from "./memory-manager.js";
import { getAbmindEnv } from "./env-schema.js";
import { classifyEmbedding } from "./embedding-integrity.js";

export interface DiagnosticsDeps {
  manager: MemoryManager;
  memoryDir: string;
}

function ok(id: string, name: string, message: string): DoctorCheckResult {
  return { id, name, status: "ok", message };
}

function warn(id: string, name: string, message: string, repair?: DoctorRepairAction): DoctorCheckResult {
  return { id, name, status: "warn", message, repair };
}

function skip(id: string, name: string, message: string): DoctorCheckResult {
  return { id, name, status: "skip", message };
}

export async function runDiagnostics(deps: { manager: MemoryManager; memoryDir: string }): Promise<DoctorCheckResult[]> {
  const { manager, memoryDir } = deps;
  const db = getMemoryDb(manager);
  const results: DoctorCheckResult[] = [];
  const dbPath = join(memoryDir, "memory.db");
  const walPath = join(memoryDir, "memory.db-wal");

  // memory.db exists
  if (existsSync(dbPath)) {
    results.push(ok("memory-db-exists", "memory.db exists", dbPath));
  } else {
    results.push(warn("memory-db-exists", "memory.db exists", "missing — run abmind install"));
  }

  // schema version
  if (db) {
    try {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get() as { name: string } | undefined;
      if (!row) {
        results.push(ok("schema-version", "schema version", "no schema tracking (managed by MemoryManager)"));
      } else {
        const ver = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as { version: number } | undefined;
        results.push(ver ? ok("schema-version", "schema version", `v${ver.version}`) : ok("schema-version", "schema version", "schema_version table empty"));
      }
    } catch { results.push(skip("schema-version", "schema version", "cannot read schema")); }
  } else {
    results.push(skip("schema-version", "schema version", "no DB"));
  }

  // FTS integrity
  if (db) {
    try {
      const tables = ["extracted_memories_fts", "content_en_trigram", "content_original_trigram"];
      const corrupt: string[] = [];
      const missing: string[] = [];
      for (const t of tables) {
        const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
        if (!exists) { missing.push(t); continue; }
        try { db.exec(`INSERT INTO ${t}(${t}) VALUES('integrity-check')`); }
        catch { corrupt.push(t); }
      }
      if (corrupt.length === 0 && missing.length === 0) {
        results.push(ok("fts-integrity", "FTS integrity", `${tables.length} FTS tables healthy`));
      } else {
        results.push(warn("fts-integrity", "FTS integrity",
          `${corrupt.length} corrupt: ${corrupt.join(", ") || "none"}; ${missing.length} missing: ${missing.join(", ") || "none"}`,
          "rebuild_fts"));
      }
    } catch { results.push(skip("fts-integrity", "FTS integrity", "check failed")); }
  } else {
    results.push(skip("fts-integrity", "FTS integrity", "no DB"));
  }

  // WAL size
  try {
    if (existsSync(walPath)) {
      const size = statSync(walPath).size;
      if (size < 10 * 1024 * 1024) {
        results.push(ok("wal-size", "WAL size", `${(size / 1024).toFixed(0)}KB`));
      } else {
        results.push(warn("wal-size", "WAL size", `${(size / 1024 / 1024).toFixed(1)}MB (>10MB)`, "checkpoint_wal"));
      }
    } else {
      results.push(ok("wal-size", "WAL size", "no WAL"));
    }
  } catch { results.push(skip("wal-size", "WAL size", "cannot stat")); }

  // Memory count
  if (db) {
    try {
      const row = db.prepare("SELECT COUNT(*) as cnt FROM extracted_memories").get() as { cnt: number };
      results.push(ok("memory-count", "memory count", `${row.cnt} memories`));
    } catch { results.push(skip("memory-count", "memory count", "cannot count")); }
  } else {
    results.push(skip("memory-count", "memory count", "no DB"));
  }

  // Daily freshness
  try {
    const dailyDir = join(memoryDir, "daily");
    if (existsSync(dailyDir)) {
      const files = readdirSync(dailyDir).filter(f => f.startsWith("daily_")).sort().reverse();
      if (files.length === 0) {
        results.push(warn("daily-freshness", "daily freshness", "no daily files"));
      } else {
        const latest = files[0]!;
        const match = latest.match(/daily_(\d{4}-\d{2}-\d{2})/);
        if (match) {
          const age = Math.round((Date.now() - new Date(match[1]!).getTime()) / 86400000);
          if (age > 3) results.push(warn("daily-freshness", "daily freshness", `latest is ${age}d old (${latest})`));
          else results.push(ok("daily-freshness", "daily freshness", `${files.length} files, latest ${age}d old`));
        } else {
          results.push(ok("daily-freshness", "daily freshness", `${files.length} files`));
        }
      }
    } else {
      results.push(skip("daily-freshness", "daily freshness", "no daily/ dir"));
    }
  } catch { results.push(skip("daily-freshness", "daily freshness", "cannot read")); }

  // Embedding gaps
  if (db) {
    try {
      const row = db.prepare("SELECT COUNT(*) as cnt FROM extracted_memories WHERE embedding IS NULL").get() as { cnt: number };
      if (row.cnt === 0) results.push(ok("embedding-gaps", "embedding gaps", "all embedded"));
      else results.push(warn("embedding-gaps", "embedding gaps", `${row.cnt} memories without embeddings`, "backfill_embeddings"));
    } catch { results.push(skip("embedding-gaps", "embedding gaps", "check failed")); }
  } else {
    results.push(skip("embedding-gaps", "embedding gaps", "no DB"));
  }

  // Embedding integrity
  if (db) {
    try {
      const dimensions = getAbmindEnv().embeddingDimensions;
      const rows = db.prepare("SELECT id, embedding FROM extracted_memories WHERE embedding IS NOT NULL LIMIT 200").all() as Array<{ id: number; embedding: Buffer }>;
      const corrupted: number[] = [];
      for (const r of rows) {
        if (!classifyEmbedding(r.embedding, dimensions).valid) corrupted.push(r.id);
      }
      if (corrupted.length === 0) results.push(ok("embedding-integrity", "embedding integrity", `${rows.length} checked, all valid`));
      else results.push(warn("embedding-integrity", "embedding integrity", `${corrupted.length} corrupted embeddings`, "clear_corrupt_embeddings"));
    } catch { results.push(skip("embedding-integrity", "embedding integrity", "check failed")); }
  } else {
    results.push(skip("embedding-integrity", "embedding integrity", "no DB"));
  }

  // Sleep health
  if (db) {
    try {
      const get = (key: string): string | null => {
        const row = db.prepare("SELECT value FROM _meta WHERE key = ?").get(key) as { value: string } | undefined;
        return row?.value ?? null;
      };
      const lastSuccess = get("sleep_last_success_ts");
      const failures = parseInt(get("sleep_consecutive_failures") ?? "0", 10);
      if (failures > 3) results.push(warn("sleep-health", "sleep health", `${failures} consecutive failures`));
      else if (lastSuccess) {
        const ageH = Math.round((Date.now() - parseInt(lastSuccess, 10)) / 3600000);
        if (ageH > 48) results.push(warn("sleep-health", "sleep health", `last success ${ageH}h ago (>48h)`));
        else results.push(ok("sleep-health", "sleep health", `last success ${ageH}h ago, ${failures} failures`));
      } else results.push(skip("sleep-health", "sleep health", "no sleep runs recorded yet"));
    } catch { results.push(skip("sleep-health", "sleep health", "check failed")); }
  } else {
    results.push(skip("sleep-health", "sleep health", "no DB"));
  }

  // Backup age
  if (db) {
    try {
      const row = db.prepare("SELECT value FROM _meta WHERE key = 'last_backup_ts'").get() as { value: string } | undefined;
      if (!row) results.push(warn("backup-age", "backup age", "no backup recorded"));
      else {
        const ageD = Math.round((Date.now() - parseInt(row.value, 10)) / 86400000);
        if (ageD > 7) results.push(warn("backup-age", "backup age", `last backup ${ageD} days ago (>7d)`));
        else results.push(ok("backup-age", "backup age", `last backup ${ageD}d ago`));
      }
    } catch { results.push(skip("backup-age", "backup age", "check failed")); }
  } else {
    results.push(skip("backup-age", "backup age", "no DB"));
  }

  // Embedding provider reachability
  try {
    execSync("curl -sf http://localhost:11434/api/tags", { timeout: 3000, stdio: "pipe" });
    results.push(ok("ollama-reachable", "ollama reachable", "localhost:11434"));
  } catch {
    results.push(warn("ollama-reachable", "ollama reachable", "not reachable"));
  }

  // Embedding model
  try {
    const out = execSync("curl -sf http://localhost:11434/api/tags", { timeout: 3000, encoding: "utf-8" });
    const models = JSON.parse(out).models?.map((m: any) => m.name) ?? [];
    const config = manager.getConfig();
    const expected = config.embeddingModel ?? "nomic-embed-text";
    const has = models.some((n: string) => n.includes(expected));
    if (has) results.push(ok("embedding-model", "embedding model", expected));
    else results.push(warn("embedding-model", "embedding model", `not found (available: ${models.slice(0, 3).join(", ")}) — run: ollama pull ${expected}`));
  } catch {
    results.push(skip("embedding-model", "embedding model", "ollama not reachable"));
  }

  // sqlite-vec
  const vecPath = join(homedir(), ".local", "lib", "node_modules", "sqlite-vec");
  if (existsSync(vecPath)) {
    results.push(ok("sqlite-vec", "sqlite-vec", "loadable"));
  } else {
    results.push(warn("sqlite-vec", "sqlite-vec", "not installed (brute-force fallback) — run: abmind deps install"));
  }

  return results;
}

export async function runRepair(
  manager: MemoryManager, memoryDir: string, action: DoctorRepairAction,
): Promise<DoctorRepairResult> {
  const db = getMemoryDb(manager);

  switch (action) {
    case "rebuild_fts": {
      if (!db) return { action, outcome: "refused", message: "no database" };
      const tables = ["extracted_memories_fts", "content_en_trigram", "content_original_trigram"];
      let rebuilt = 0;
      for (const t of tables) {
        try { db.exec(`INSERT INTO ${t}(${t}) VALUES('rebuild')`); rebuilt++; } catch { }
      }
      return { action, outcome: "applied", message: `rebuilt ${rebuilt}/${tables.length} FTS tables` };
    }
    case "checkpoint_wal": {
      if (!db) return { action, outcome: "refused", message: "no database" };
      db.pragma("wal_checkpoint(TRUNCATE)");
      return { action, outcome: "applied", message: "WAL checkpointed" };
    }
    case "backfill_embeddings": {
      const provider = manager.getEmbeddingProvider();
      if (!provider) return { action, outcome: "refused", message: "embedding provider not available" };
      const logPath = join(homedir(), ".abmind", "logs", "embed.log");
      manager.backfillEmbeddings(provider).then(r => {
        appendFileSync(logPath, `${new Date().toISOString()} backfill_embeddings: embedded ${r.embedded}\n`);
      }).catch((err: Error) => {
        appendFileSync(logPath, `${new Date().toISOString()} backfill_embeddings failed: ${err.message}\n`);
      });
      return { action, outcome: "applied", message: "backfill started in background" };
    }
    case "clear_corrupt_embeddings": {
      if (!db) return { action, outcome: "refused", message: "no database" };
      const dimensions = getAbmindEnv().embeddingDimensions;
      const rows = db.prepare("SELECT id, user_id, semantic_revision, embedding FROM extracted_memories WHERE embedding IS NOT NULL LIMIT 500").all() as Array<{ id: number; user_id: string; semantic_revision: number; embedding: Buffer }>;
      const corrupted: Array<{ id: number; userId: string; revision: number }> = [];
      for (const r of rows) {
        if (!classifyEmbedding(r.embedding, dimensions).valid) corrupted.push({ id: r.id, userId: r.user_id, revision: r.semantic_revision });
      }
      if (corrupted.length === 0) return { action, outcome: "applied", message: "no corrupted embeddings found" };
      const stmt = db.prepare("UPDATE extracted_memories SET embedding = NULL WHERE id = ? AND user_id = ? AND semantic_revision = ?");
      for (const row of corrupted) stmt.run(row.id, row.userId, row.revision);
      return { action, outcome: "applied", message: `nulled ${corrupted.length} corrupted embeddings` };
    }
  }
}
