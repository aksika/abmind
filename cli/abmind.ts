#!/usr/bin/env node
/**
 * abmind — Unified CLI for abtars Memory.
 *
 * Dispatcher shape: a single table of { name, file, aliases?, help } entries.
 * Adding a subcommand is one line. No env-var smuggling — secrets subcommands
 * call runSecretsCommand(action) directly.
 */

process.umask(0o077); // #441: all runtime files 600, dirs 700
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { acquireLock, standalonePaths } from "../src/deploy-lib/index.js";

interface Entry {
  readonly name: string;
  readonly help: string;
  /** Subcommand module filename inside dist/cli/. */
  readonly file?: string;
  /** Custom runner — used by secrets subcommands that share one file. */
  readonly run?: () => Promise<void> | void;
}

// Resolve subcommand siblings via the package root, not relative to this script.
// npm may copy this bin to node_modules/.bin/abmind (not a symlink).
// #1243: abmind is no longer deployed inside the abtars bundle — resolve from
// its own package root (global install at ~/.local/lib, or npm link).
const req = createRequire(import.meta.url);
const pkgDir = dirname(req.resolve("abmind/package.json"));
const load = (name: string): Promise<unknown> =>
  import(pathToFileURL(`${pkgDir}/dist/cli/${name}`).href);

const DISPATCH: readonly Entry[] = [
  // Lifecycle (#158 Phase 4)
  { name: "install",         file: "abmind-install.js",       help: "First-time setup of ~/.abmind" },
  { name: "install-host",    file: "abmind-install-host.js",  help: "Install abmind into Claude Code or Gemini CLI" },
  { name: "update",          file: "abmind-update.js",        help: "Standalone update — acquire and activate a new release" },
  { name: "install-standalone", help: "Install standalone (used by bootstrap script)",
    run: async () => {
      const { parseArgs } = await import("./abmind-update-args.js") as typeof import("./abmind-update-args.js");
      const { installStandalone, defaultDeps } = await import("./lib/standalone-installer.js") as typeof import("./lib/standalone-installer.js");
      const args = process.argv.slice(2);
      // `--artifact <path>` installs a specific local tarball as the release
      // (used by the bootstrap's ABMIND_BOOTSTRAP_TARBALL path). Strip it
      // before the strict channel parser sees it.
      let artifactPath: string | undefined;
      const chanArgs: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--artifact") {
          artifactPath = args[++i];
        } else if (args[i]?.startsWith("--artifact=")) {
          artifactPath = args[i]!.slice("--artifact=".length);
        } else {
          chanArgs.push(args[i]!);
        }
      }
      const parsed = parseArgs(chanArgs);
      if (parsed === "help" || parsed === "error") {
        process.stdout.write("Usage: abmind install-standalone --stable|--alpha|--dev [DIR] [--artifact <tarball.tgz>]\n");
        process.exit(parsed === "help" ? 0 : 2);
      }
      const sp = standalonePaths();
      const release = await acquireLock(sp.lock, `install-standalone --${parsed.channel}`);
      try {
        const result = await installStandalone(
          { channel: parsed.channel, explicitDevDir: parsed.localDir, artifactPath },
          defaultDeps(),
        );
        process.stdout.write(result.changed
          ? `Installed: ${result.release.releaseId}\n`
          : `Already up to date: ${result.release.releaseId}\n`);
        if (result.shadowedBy) {
          process.stderr.write(`WARNING: shadowed by ${result.shadowedBy}\n`);
          process.exit(1);
        }
        process.exit(0);
      } finally {
        await release();
      }
    } },
  { name: "doctor",          file: "abmind-doctor.js",        help: "Health check — permissions, DB, ollama, templates" },
  { name: "status",          file: "abmind-status-runtime.js", help: "Show lifecycle status (version, lock, symlink)" },
  // Deps
  { name: "deps", help: "Manage native deps (better-sqlite3, sqlite-vec)",
    run: async () => {
      const m = await load("abmind-deps.js") as typeof import("./abmind-deps.js");
      const code = await m.deps(process.argv.slice(2));
      if (code !== 0) process.exit(code);
    } },
  // Memory-facing
  { name: "recall",          file: "abmind-recall.js",        help: "Search memories" },
  { name: "store",           file: "abmind-store.js",         help: "Store a new memory" },
  { name: "ingest",          file: "abmind-ingest.js",        help: "Ingest a document into memory" },
  { name: "backup",          file: "abmind-backup.js",        help: "Create encrypted backup" },
  { name: "restore",         file: "abmind-restore.js",       help: "Restore from encrypted backup" },
  { name: "passwd",          file: "abmind-passwd.js",        help: "Change encryption passphrase" },
  { name: "edit",            file: "abmind-edit.js",          help: "Edit an existing memory" },
  { name: "expand",          file: "abmind-expand.js",        help: "Look up source messages by ID" },
  { name: "embed",           file: "abmind-embed.js",         help: "Batch embed all memories" },
  { name: "retro-extract",   file: "abmind-retro-extract.js", help: "Extract facts from retrospective files" },
  { name: "wake-up",         file: "abmind-wakeup.js",        help: "Print current wake-up context" },
  { name: "bundle",          file: "abmind-bundle.js",        help: "Print session bundle (SOUL + profile + notes + memory-tools)" },
  { name: "sleep",           file: "abmind-sleep.js",         help: "Run a sleep cycle (--level basic|budget|normal|ultimate)" },
  { name: "sleep-state",     file: "abmind-sleep-state.js",   help: "Show sleep candidates (JSON)" },
  { name: "sleep-apply",     file: "abmind-sleep-apply.js",   help: "Promote/demote memories (--promote --demote --dry-run)" },
  { name: "sleep-report",    file: "abmind-sleep-report.js",  help: "Generate dream report" },
  { name: "operational",     file: "abmind-operational.js",   help: "Operational memory: draft, recall, promote, reject, revise, retire, history" },
  { name: "service",         file: "abmind-service.js",       help: "Manage the abmind daemon as a native user service" },
  { name: "mcp",             file: "abmind-mcp.js",           help: "Start MCP server (stdio)" },
  { name: "migrate-openclaw", file: "abmind-migrate-openclaw.js", help: "Import OpenClaw session transcripts (.jsonl)" },
  // Kiro CLI hooks (#344)
  { name: "hook-wakeup",       file: "abmind-hook-wakeup.js",       help: "Kiro agentSpawn hook — wake-up context injection" },
  { name: "hook-recall",       file: "abmind-hook-recall.js",       help: "Kiro userPromptSubmit hook — memory recall injection" },
  { name: "hook-store",        file: "abmind-hook-store.js",        help: "Kiro stop hook — turn recording" },
  { name: "hook-preToolUse",   file: "abmind-hook-preToolUse.js",   help: "Kiro preToolUse hook — security gate (blocks direct DB writes)" },
  { name: "hook-postToolUse",  file: "abmind-hook-postToolUse.js",  help: "Kiro postToolUse hook — captures tool context for memory" },
  { name: "hook-doctor",       file: "abmind-hook-doctor.js",       help: "Diagnose hook config, errors, active sidecars" },
  { name: "list-secrets",    help: "Show SECRET memory metadata",
    run: async () => {
      if (process.argv.slice(2).includes("--help")) { console.log("Usage: abmind list-secrets\n\nShow SECRET memory metadata (no content, no decryption)."); return; }
      const m = await load("abmind-secrets.js") as typeof import("./abmind-secrets.js"); const { printBanner } = await import("./banner.js"); await printBanner("list-secrets"); m.runSecretsCommand("list");
    } },
  { name: "encrypt-secrets", help: "Encrypt existing SECRET memories",
    run: async () => {
      if (process.argv.slice(2).includes("--help")) { console.log("Usage: abmind encrypt-secrets\n\nEncrypt existing classification=3 rows."); return; }
      const m = await load("abmind-secrets.js") as typeof import("./abmind-secrets.js"); const { printBanner } = await import("./banner.js"); await printBanner("encrypt-secrets"); m.runSecretsCommand("encrypt");
    } },
  { name: "rekey",           help: "Re-encrypt with new key (--old-key <path>)",
    run: async () => {
      if (process.argv.slice(2).includes("--help")) { console.log("Usage: abmind rekey --old-key <path-to-old-keyfile>\n\nRe-encrypt encrypted memories with a new key."); return; }
      const m = await load("abmind-secrets.js") as typeof import("./abmind-secrets.js"); m.runSecretsCommand("rekey");
    } },
];

function printHelp(): void {
  console.log("abmind — abtars Memory CLI\n\nSubcommands:");
  const width = Math.max(...DISPATCH.map(e => e.name.length));
  for (const e of DISPATCH) {
    console.log(`  ${e.name.padEnd(width)}  ${e.help}`);
  }
  console.log("\nRun 'abmind <subcommand> --help' for details.");
}

const subcommand = process.argv[2];
if (!subcommand || subcommand === "--help" || subcommand === "-h") {
  printHelp();
  process.exit(0);
}

if (subcommand === "--version" || subcommand === "-v" || subcommand === "version") {
  const here = dirname(new URL(import.meta.url).pathname);
  try {
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf-8"));
    console.log(pkg.version);
  } catch {
    console.log("unknown");
  }
  process.exit(0);
}

const entry = DISPATCH.find(e => e.name === subcommand);
if (!entry) {
  console.error(`Unknown subcommand: ${subcommand}\nRun 'abmind --help' for usage.`);
  process.exit(1);
}

// Native deps resolved via NODE_PATH=~/.local/lib/node_modules (set by wrapper script)

// Shift argv so subcommand handlers see their args at argv[2+].
process.argv.splice(2, 1);

if (entry.run) {
  await entry.run();
} else if (entry.file) {
  await load(entry.file);
}
