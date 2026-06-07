/**
 * abmind restore — Restore from encrypted .abm backup.
 */

import { join } from "node:path";
import { runCli } from "../src/cli-runner.js";
import type { FlagSpec } from "../src/cli-flags.js";
import { initializeDatabase } from "../src/memory-db.js";
import { abmindHome } from "../src/mem-paths.js";
import { restoreBackup } from "../src/backup.js";
import { MemoryManager } from "../src/memory-manager.js";
import { loadMemoryConfig } from "../src/memory-config.js";

async function rebuildEmbeddings(): Promise<void> {
  try {
    const config = loadMemoryConfig();
    const mm = new MemoryManager(config);
    const provider = mm.getEmbeddingProvider?.();
    if (!provider) { console.log("⚠️ No embedding provider — skipping rebuild"); return; }
    const { embedded } = await mm.backfillEmbeddings(provider);
    console.log(`✅ Embeddings rebuilt: ${embedded} memories`);
  } catch (err) {
    console.log(`⚠️ Embedding rebuild skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const FLAGS: readonly FlagSpec[] = [
  { name: "input", type: "string" },
  { name: "mode", type: "string" },
  { name: "passphrase", type: "string" },
  { name: "passphrase-env", type: "string" },
  { name: "username", type: "string" },
];

await runCli(import.meta.url, {
  name: "abmind-restore",
  help: `Usage:
  abmind restore --input <file.abm> [--mode merge|replace] [--passphrase <p>] [--username <name>]

Options:
  --input <file>          Path to .abm backup file (required)
  --mode <mode>           merge (default, skip existing) or replace (wipe + restore)
  --passphrase <p>        Decryption passphrase (default: derived from ~/.abmind/secret/abmind.key)
  --passphrase-env <VAR>  Read passphrase from env var (default: ABMIND_BACKUP_PASSPHRASE)
  --username <name>       Name used as encryption salt (default: from manifest or OS user)`,
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
    let username = (args["username"] as string) ?? undefined;
    const mode = ((args["mode"] as string) ?? "merge") as "merge" | "replace";

    try {
      const result = restoreBackup(db, memoryDir, passphrase, inputPath, mode, username);
      console.log(`✅ Restore (${mode}): ${result.restored} memories, ${result.files} files (${result.skipped} skipped)`);
      await rebuildEmbeddings();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Decryption failed") && process.stdin.isTTY) {
        // Prompt for passphrase + username
        const { createInterface } = await import("node:readline");
        if (!passphrase) {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          passphrase = await new Promise<string>(resolve => {
            rl.question("Enter passphrase: ", answer => { rl.close(); resolve(answer.trim()); });
          });
        }
        if (!username) {
          const rl2 = createInterface({ input: process.stdin, output: process.stdout });
          username = await new Promise<string>(resolve => {
            rl2.question("Name used for encryption (e.g. aksika): ", answer => { rl2.close(); resolve(answer.trim()); });
          });
        }
        try {
          const result = restoreBackup(db, memoryDir, passphrase, inputPath, mode, username);
          console.log(`✅ Restore (${mode}): ${result.restored} memories, ${result.files} files (${result.skipped} skipped)`);
          await rebuildEmbeddings();
        } catch {
          console.log(JSON.stringify({ ok: false, error: "Decryption failed — wrong passphrase or username" }));
        }
      } else {
        console.log(JSON.stringify({ ok: false, error: msg }));
      }
    }
    db.close();
  },
});
