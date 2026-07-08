/**
 * abmind backup — Create backup of memory system.
 *
 * Modes:
 *   (default/full)  → .zip: filesystem (excl secret/) + encrypted .abm inside
 *   --database      → .abm: encrypted DB only
 *   --config        → .zip: secret/ + config/ only
 */

import { join, basename } from "node:path";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { runCli } from "../src/cli-runner.js";
import type { FlagSpec } from "../src/cli-flags.js";
import { initializeDatabase } from "../src/memory-db.js";
import { abmindHome } from "../src/mem-paths.js";
import { createBackup } from "../src/backup.js";

const FLAGS: readonly FlagSpec[] = [
  { name: "output", type: "string" },
  { name: "passphrase", type: "string" },
  { name: "passphrase-env", type: "string" },
  { name: "database", type: "boolean" },
  { name: "config", type: "boolean" },
];

const FULL_EXCLUDE = ["lib", "node_modules", "backups", "working", "secret", "current", "releases", "bin", "src", "memory/memory.db", "memory/memory.db-wal", "memory/memory.db-shm", "*.sock", "*.db-wal", "*.db-shm"];
const CONFIG_INCLUDE = ["secret", "config"];

function timestamp(): string {
  const now = new Date();
  const d = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const t = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  return `${d}-${t}`;
}

await runCli(import.meta.url, {
  name: "abmind-backup",
  banner: "backup",
  help: `Usage:
  abmind backup [--database | --config] [--output <path>] [--passphrase <p>]

Modes:
  (default)    Full backup: zip of ~/.abmind/ (excl secret/) + encrypted .abm inside
  --database   DB-only: encrypted .abm file (memories, messages, entities)
  --config     Config: zip of secret/ + config/ (contains master key)

Options:
  --output <path>         Output file/dir (default: ~/.abmind/backups/)
  --passphrase <p>        Encryption passphrase (default: from ~/.abmind/secret/abmind.key)
  --passphrase-env <VAR>  Read passphrase from env var`,
  flags: FLAGS,
  handler: async ({ args }) => {
    const home = abmindHome();
    const memoryDir = join(home, "memory");
    const backupsDir = join(home, "backups");
    mkdirSync(backupsDir, { recursive: true });

    const envVar = (args["passphrase-env"] as string) ?? "ABMIND_BACKUP_PASSPHRASE";
    const passphrase = (args["passphrase"] as string) ?? process.env[envVar] ?? undefined;
    const ts = timestamp();
    const isDb = !!args["database"];
    const isConfig = !!args["config"];

    if (isDb) {
      // --database: produce .abm only
      const outPath = (args["output"] as string) ?? join(backupsDir, `abmind-${ts}.abm`);
      const db = initializeDatabase(join(memoryDir, "memory.db"));
      const result = createBackup(db, memoryDir, passphrase, outPath, { dbOnly: true });
      db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('last_backup_ts', ?)").run(String(Date.now()));
      db.close();
      console.log(`✅ Backup: ${result.memories} memories → ${result.path} (${Math.round(result.sizeBytes / 1024)}KB)`);
      return;
    }

    if (isConfig) {
      // --config: zip secret/ + config/
      const outPath = (args["output"] as string) ?? join(backupsDir, `abmind-config-${ts}.zip`);
      const dirs = CONFIG_INCLUDE.filter(d => existsSync(join(home, d)));
      if (dirs.length === 0) { console.error("Nothing to backup"); process.exit(1); }
      const ok = zipDirs(home, dirs, outPath);
      if (!ok) { console.error("zip failed"); process.exit(1); }
      console.log(`✅ Config backup → ${outPath}`);
      return;
    }

    // Full (default): produce .abm first, then zip filesystem + .abm inside
    const abmPath = join(backupsDir, `abmind-${ts}.abm`);
    const db = initializeDatabase(join(memoryDir, "memory.db"));
    const abmResult = createBackup(db, memoryDir, passphrase, abmPath, { dbOnly: false });
    db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('last_backup_ts', ?)").run(String(Date.now()));
    db.close();

    // Zip filesystem (excl secret/) + nest .abm inside
    const has7z = spawnSync("which", ["7z"], { encoding: "utf-8" }).status === 0;
    const ext = has7z ? "7z" : "zip";
    const outPath = (args["output"] as string) ?? join(backupsDir, `abmind-${ts}.${ext}`);

    let ok: boolean;
    if (has7z) {
      const excludeArgs = FULL_EXCLUDE.flatMap(ex => ["-xr!" + ex]);
      ok = spawnSync("7z", ["a", outPath, ".", ...excludeArgs], { cwd: home, encoding: "utf-8" }).status === 0;
      if (ok) spawnSync("7z", ["a", outPath, abmPath], { encoding: "utf-8" });
    } else {
      const excludePatterns = FULL_EXCLUDE.flatMap(ex => [`${ex}/*`, ex]);
      ok = spawnSync("zip", ["-qr", outPath, ".", "-x", ...excludePatterns], { cwd: home, encoding: "utf-8" }).status === 0;
      if (ok) spawnSync("zip", ["-qj", outPath, abmPath], { encoding: "utf-8" });
    }

    // Remove standalone .abm (it's inside the zip now)
    try { unlinkSync(abmPath); } catch { /* ignore */ }

    if (!ok) { console.error("zip failed"); process.exit(1); }
    console.log(`✅ Backup: ${abmResult.memories} memories, ${abmResult.files} files → ${outPath}`);
  },
});

function zipDirs(cwd: string, dirs: string[], outPath: string): boolean {
  const has7z = spawnSync("which", ["7z"], { encoding: "utf-8" }).status === 0;
  if (has7z) {
    return spawnSync("7z", ["a", outPath, ...dirs], { cwd, encoding: "utf-8" }).status === 0;
  }
  return spawnSync("zip", ["-qr", outPath, ...dirs], { cwd, encoding: "utf-8" }).status === 0;
}
