/**
 * abmind restore — Restore from backup (.abm or .zip).
 *
 * Usage: abmind restore <file> [--mode merge|replace] [--passphrase <p>] [--username <name>]
 */

import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { runCli } from "../src/cli-runner.js";
import type { FlagSpec } from "../src/cli-flags.js";
import { initializeDatabase } from "../src/memory-db.js";
import { abmindHome } from "../src/mem-paths.js";
import { restoreBackup } from "../src/backup.js";
import { MemoryManager } from "../src/memory-manager.js";
import { loadMemoryConfig } from "../src/memory-config.js";
import { deriveFromPassphrase } from "../src/crypto.js";
import { hkdfSync } from "node:crypto";

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
  { name: "mode", type: "string" },
  { name: "passphrase", type: "string" },
  { name: "passphrase-env", type: "string" },
  { name: "username", type: "string" },
];

await runCli(import.meta.url, {
  name: "abmind-restore",
  banner: "restore",
  help: `Usage:
  abmind restore <file.abm|file.zip> [--mode merge|replace] [--passphrase <p>] [--username <name>]

Arguments:
  <file>            Path to .abm (encrypted DB) or .zip (full backup)

Options:
  --mode <mode>           merge (default, skip existing) or replace (wipe + restore)
  --passphrase <p>        Decryption passphrase (default: from ~/.abmind/secret/abmind.key)
  --passphrase-env <VAR>  Read passphrase from env var
  --username <name>       Name used as encryption salt (required on fresh install)`,
  flags: FLAGS,
  handler: async ({ args }) => {
    // Positional: first non-flag arg after "restore"
    const argv = process.argv.slice(2);
    const inputPath = argv.find(a => !a.startsWith("-") && a !== "restore");
    if (!inputPath || (!inputPath.endsWith(".abm") && !inputPath.endsWith(".zip") && !inputPath.endsWith(".7z"))) {
      console.error("Error: provide path to .abm, .zip, or .7z file\nUsage: abmind restore <file.abm|file.zip|file.7z>");
      process.exit(1);
    }
    if (!existsSync(inputPath)) {
      console.error(`File not found: ${inputPath}`);
      process.exit(1);
    }

    const home = abmindHome();
    const memoryDir = join(home, "memory");
    const mode = ((args["mode"] as string) ?? "merge") as "merge" | "replace";
    const envVar = (args["passphrase-env"] as string) ?? "ABMIND_BACKUP_PASSPHRASE";
    let passphrase = (args["passphrase"] as string) ?? process.env[envVar] ?? undefined;
    let username = (args["username"] as string) ?? undefined;

    if (inputPath.endsWith(".zip") || inputPath.endsWith(".7z")) {
      await restoreFromZip(inputPath, home, memoryDir, mode, passphrase, username);
    } else {
      await restoreFromAbm(inputPath, home, memoryDir, mode, passphrase, username);
    }
  },
});

async function restoreFromAbm(abmPath: string, home: string, memoryDir: string, mode: "merge" | "replace", passphrase?: string, username?: string): Promise<void> {
  mkdirSync(memoryDir, { recursive: true });
  const db = initializeDatabase(join(memoryDir, "memory.db"));

  try {
    let result = restoreBackup(db, memoryDir, passphrase, abmPath, mode, username);
    // 0 memories likely means wrong passphrase — prompt if interactive
    if (result.restored === 0 && result.files === 0 && process.stdin.isTTY) {
      console.error("⚠ 0 memories restored — likely wrong passphrase.");
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      passphrase = await new Promise<string>(resolve => { rl.question("Enter original passphrase: ", a => { rl.close(); resolve(a.trim()); }); });
      const rl2 = createInterface({ input: process.stdin, output: process.stdout });
      username = await new Promise<string>(resolve => { rl2.question("Encryption username: ", a => { rl2.close(); resolve(a.trim()); }); });
      result = restoreBackup(db, memoryDir, passphrase, abmPath, mode, username);
    }
    if (result.restored === 0 && result.files === 0) {
      console.error("⚠ 0 memories restored. Re-run with: abmind restore <file> --passphrase <original>");
      db.close();
      process.exit(1);
    }
    console.log(`✅ Restore (${mode}): ${result.restored} memories, ${result.files} files (${result.skipped} skipped)`);
    saveKeyOnFresh(home, passphrase, username);
    await rebuildEmbeddings();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Decryption failed") && process.stdin.isTTY) {
      if (!passphrase) {
        const { createInterface } = await import("node:readline");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        passphrase = await new Promise<string>(resolve => { rl.question("Enter passphrase: ", a => { rl.close(); resolve(a.trim()); }); });
      }
      if (!username) {
        const { createInterface } = await import("node:readline");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        username = await new Promise<string>(resolve => { rl.question("Encryption username: ", a => { rl.close(); resolve(a.trim()); }); });
      }
      try {
        const result = restoreBackup(db, memoryDir, passphrase, abmPath, mode, username);
        console.log(`✅ Restore (${mode}): ${result.restored} memories, ${result.files} files (${result.skipped} skipped)`);
        saveKeyOnFresh(home, passphrase, username);
        await rebuildEmbeddings();
      } catch {
        console.error("Decryption failed — wrong passphrase or username");
        process.exit(1);
      }
    } else {
      console.error(msg);
      process.exit(1);
    }
  }
  db.close();
}

async function restoreFromZip(zipPath: string, home: string, memoryDir: string, mode: "merge" | "replace", passphrase?: string, username?: string): Promise<void> {
  // Unzip to temp
  const tmpDir = join(process.env["TMPDIR"] ?? "/tmp", `abmind-restore-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  const is7z = zipPath.endsWith(".7z");
  const result = is7z
    ? spawnSync("7z", ["x", `-o${tmpDir}`, zipPath], { encoding: "utf-8" })
    : spawnSync("unzip", ["-qo", zipPath, "-d", tmpDir], { encoding: "utf-8" });

  if (result.status !== 0) {
    console.error("Failed to extract zip");
    process.exit(1);
  }

  // Find .abm inside
  const abmFile = readdirSync(tmpDir).find(f => f.endsWith(".abm"));
  if (abmFile) {
    await restoreFromAbm(join(tmpDir, abmFile), home, memoryDir, mode, passphrase, username);
  } else {
    console.error("No .abm found inside zip — cannot restore DB");
    process.exit(1);
  }

  // Copy filesystem dirs (core/, daily/, weekly/, etc.) to ~/.abmind/memory/
  const skipDirs = new Set(["secret", "config", "lib", "node_modules", "backups"]);
  for (const entry of readdirSync(tmpDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (skipDirs.has(entry.name)) continue;
    if (entry.name === "memory") {
      // memory/ subdirs go into ~/.abmind/memory/
      const memSrc = join(tmpDir, "memory");
      for (const sub of readdirSync(memSrc, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const dest = join(memoryDir, sub.name);
        mkdirSync(dest, { recursive: true });
        cpSync(join(memSrc, sub.name), dest, { recursive: true, force: mode === "replace" });
      }
    } else {
      // Top-level dirs (prompts/, etc.) go to ~/.abmind/
      const dest = join(home, entry.name);
      mkdirSync(dest, { recursive: true });
      cpSync(join(tmpDir, entry.name), dest, { recursive: true, force: mode === "replace" });
    }
  }

  // Cleanup
  rmSync(tmpDir, { recursive: true, force: true });
  console.log("✓ Filesystem restored from zip");

  // Reconcile templates → ensure prompts/sleep are fresh from source
  const { fileURLToPath } = await import("node:url");
  const repoRoot = dirname(fileURLToPath(import.meta.url)).replace(/[/\\]dist[/\\]cli$/, '').replace(/[/\\]cli$/, '');
  const templatesSrc = join(repoRoot, 'templates');
  if (existsSync(templatesSrc)) {
    const { reconcile } = await import('../src/reconcile.js');
    reconcile(templatesSrc, home);
    console.log("✓ reconciled templates");
  }
}

function saveKeyOnFresh(home: string, passphrase?: string, username?: string): void {
  const keyPath = join(home, "secret", "abmind.key");
  if (existsSync(keyPath)) return; // already has key

  let key: Buffer | undefined;
  if (passphrase && username) {
    key = deriveFromPassphrase(passphrase, username);
  }
  if (!key) return;

  // Persist derived key
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
  console.log("✓ Encryption key saved");

  // Persist encryptionUser in manifest.json
  if (username) {
    const manifestPath = join(home, "manifest.json");
    try {
      const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf-8")) : {};
      manifest.encryptionUser = username;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      console.log("✓ encryptionUser saved to manifest.json");
    } catch { /* non-fatal */ }
  }
}
