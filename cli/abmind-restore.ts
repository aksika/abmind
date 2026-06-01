/**
 * abmind restore — Restore from encrypted .abm backup.
 */

import { join } from "node:path";
import { runCli } from "../src/cli-runner.js";
import type { FlagSpec } from "../src/cli-flags.js";
import { initializeDatabase } from "../src/memory-db.js";
import { abmindHome } from "../src/mem-paths.js";
import { restoreBackup } from "../src/backup.js";

const FLAGS: readonly FlagSpec[] = [
  { name: "input", type: "string" },
  { name: "mode", type: "string" },
  { name: "passphrase", type: "string" },
  { name: "passphrase-env", type: "string" },
];

await runCli(import.meta.url, {
  name: "abmind-restore",
  help: `Usage:
  abmind restore --input <file.abm> [--mode merge|replace] [--passphrase <p> | --passphrase-env <VAR>]

Options:
  --input <file>          Path to .abm backup file (required)
  --mode <mode>           merge (default, skip existing) or replace (wipe + restore)
  --passphrase <p>        Decryption passphrase (default: derived from ~/.abmind/secret/abmind.key)
  --passphrase-env <VAR>  Read passphrase from env var (default: ABMIND_BACKUP_PASSPHRASE)`,
  flags: FLAGS,
  handler: async ({ args }) => {
    const inputPath = (args["input"] as string | undefined) ?? process.argv.find(a => a.endsWith(".abm") && !a.startsWith("-"));
    if (!inputPath) {
      console.error("Error: provide path to .abm file\nUsage: abmind restore <file.abm> or abmind restore --input <file.abm>");
      process.exit(1);
    }

    const memoryDir = join(abmindHome(), "memory");
    const db = initializeDatabase(join(memoryDir, "memory.db"));

    const envVar = (args["passphrase-env"] as string) ?? "ABMIND_BACKUP_PASSPHRASE";
    let passphrase = (args["passphrase"] as string) ?? process.env[envVar] ?? undefined;
    const mode = ((args["mode"] as string) ?? "merge") as "merge" | "replace";

    try {
      const result = restoreBackup(db, memoryDir, passphrase, inputPath, mode);
      console.log(`✅ Restore (${mode}): ${result.restored} memories, ${result.files} files (${result.skipped} skipped)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Decryption failed") && !passphrase && process.stdin.isTTY) {
        // Prompt for passphrase
        const { createInterface } = await import("node:readline");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        passphrase = await new Promise<string>(resolve => {
          rl.question("Backup encrypted with different key. Enter passphrase: ", answer => { rl.close(); resolve(answer.trim()); });
        });
        const result = restoreBackup(db, memoryDir, passphrase, inputPath, mode);
        console.log(`✅ Restore (${mode}): ${result.restored} memories, ${result.files} files (${result.skipped} skipped)`);
      } else {
        console.log(JSON.stringify({ ok: false, error: msg }));
      }
    }
    db.close();
  },
});
