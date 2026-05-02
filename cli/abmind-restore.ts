/**
 * abmind restore — Restore from encrypted backup.
 */

import { join } from "node:path";
import { runCli } from "../src/cli-runner.js";
import type { FlagSpec } from "../src/cli-flags.js";
import { initializeDatabase } from "../src/memory-db.js";
import { abmindHome } from "../src/mem-paths.js";
import { restoreBackup } from "../src/backup.js";

const FLAGS: readonly FlagSpec[] = [
  { name: "input", type: "string" },
  { name: "passphrase", type: "string" },
  { name: "passphrase-env", type: "string" },
  { name: "mode", type: "string" },
  { name: "yes", type: "boolean" },
];

await runCli(import.meta.url, {
  name: "abmind-restore",
  help: `Usage:
  abmind restore --input <path> [--mode merge|replace] [--passphrase <p>] [--yes]

Options:
  --input <path>          Backup file to restore from (required)
  --mode <m>              merge (default, skip duplicates) | replace (wipe + restore, requires --yes)
  --passphrase <p>        Decryption passphrase
  --passphrase-env <VAR>  Read passphrase from env var (default: ABMIND_BACKUP_PASSPHRASE)
  --yes                   Skip confirmation for --mode replace`,
  flags: FLAGS,
  handler: async ({ args }) => {
    const inputPath = args["input"] as string;
    if (!inputPath) { console.error("Error: --input required"); process.exit(1); }

    const mode = (args["mode"] as string) ?? "merge";
    if (mode !== "merge" && mode !== "replace") { console.error("Error: --mode must be merge or replace"); process.exit(1); }

    if (mode === "replace" && !args["yes"]) {
      console.error("⚠️  --mode replace will WIPE all existing memories. Add --yes to confirm.");
      process.exit(1);
    }

    const envVar = (args["passphrase-env"] as string) ?? "ABMIND_BACKUP_PASSPHRASE";
    const passphrase = (args["passphrase"] as string) ?? process.env[envVar];
    if (!passphrase) {
      console.error(`Error: passphrase required. Use --passphrase, --passphrase-env, or set ${envVar}`);
      process.exit(1);
    }

    const memoryDir = join(abmindHome(), "memory");
    const db = initializeDatabase(join(memoryDir, "memory.db"));

    try {
      const result = restoreBackup(db, memoryDir, passphrase, inputPath, mode);
      console.log(`✅ Restored (${mode}): ${result.restored} memories, ${result.skipped} skipped, ${result.files} files`);
    } catch (err) {
      console.error(`❌ Restore failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      db.close();
    }
  },
});
