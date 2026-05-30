/**
 * abmind backup — Create encrypted backup of memory DB + files.
 */

import { join } from "node:path";
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
];

await runCli(import.meta.url, {
  name: "abmind-backup",
  help: `Usage:
  abmind backup [--database] [--output <path>] [--passphrase <p> | --passphrase-env <VAR>]

Options:
  --database              DB-only backup (no core/weekly/config files)
  --output <path>         Output file (default: ~/.abmind/backups/abmind-<timestamp>.abm)
  --passphrase <p>        Encryption passphrase (default: derived from ~/.abmind/secret/abmind.key)
  --passphrase-env <VAR>  Read passphrase from env var (default: ABMIND_BACKUP_PASSPHRASE)`,
  flags: FLAGS,
  handler: async ({ args }) => {
    const memoryDir = join(abmindHome(), "memory");
    const db = initializeDatabase(join(memoryDir, "memory.db"));

    // Resolve passphrase (optional — falls back to ~/.abmind/secret/abmind.key)
    const envVar = (args["passphrase-env"] as string) ?? "ABMIND_BACKUP_PASSPHRASE";
    const passphrase = (args["passphrase"] as string) ?? process.env[envVar] ?? undefined;

    // Resolve output path
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    const dbOnly = !!args["database"];
    const defaultName = dbOnly ? `abmind-db-${ts}.abm` : `abmind-${ts}.abm`;
    const defaultPath = join(abmindHome(), "backups", defaultName);
    const outputPath = (args["output"] as string) ?? defaultPath;

    const result = createBackup(db, memoryDir, passphrase, outputPath, { dbOnly });
    console.log(`✅ Backup: ${result.memories} memories, ${result.files} files → ${result.path} (${Math.round(result.sizeBytes / 1024)}KB)`);
    db.close();
  },
});
