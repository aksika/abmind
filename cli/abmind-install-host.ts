#!/usr/bin/env node
/**
 * abmind install-host — atomic installer for Claude Code + Gemini extensions (#368).
 * Usage: abmind install-host <claude|gemini|codex> [--uninstall]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, lstatSync, readdirSync, copyFileSync, readlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve package root (works from dist/cli/ or cli/)
const pkgRoot = join(__dirname, "..", "..");

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h") || args.length === 0) {
  console.log(`abmind install-host — install abmind into a host AI tool

Usage: abmind install-host <claude|gemini|codex> [--uninstall]

Hosts:
  claude   — Claude Code (hooks + MCP + CLAUDE.md)
  gemini   — Gemini CLI (hooks + MCP + GEMINI.md)
  codex    — Codex CLI (hooks + CODEX.md)

Options:
  --uninstall   Remove abmind integration from the host`);
  process.exit(0);
}

const host = args.find(a => !a.startsWith("-"));
const uninstall = args.includes("--uninstall");

if (!host || !["claude", "gemini", "codex"].includes(host)) {
  console.error(`Error: unknown host "${host}". Use "claude", "gemini", or "codex".`);
  process.exit(1);
}

if (host === "claude") {
  uninstall ? uninstallClaude() : installClaude();
} else if (host === "gemini") {
  uninstall ? uninstallGemini() : installGemini();
} else {
  uninstall ? uninstallCodex() : installCodex();
}

// ── Claude Code ─────────────────────────────────────────────────────────────

function installClaude(): void {
  const claudeDir = join(homedir(), ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  const backupPath = settingsPath + ".pre-abmind.bak";
  const claudeMdSource = join(pkgRoot, "claude-code-extension", "CLAUDE.md");
  const claudeMdTarget = join(claudeDir, "CLAUDE.md");
  const sourceSettings = JSON.parse(readFileSync(join(pkgRoot, "claude-code-extension", "settings.json"), "utf-8"));

  mkdirSync(claudeDir, { recursive: true });

  // Backup existing settings (once)
  if (existsSync(settingsPath) && !existsSync(backupPath)) {
    copyFileSync(settingsPath, backupPath);
    console.log(`✓ Backed up ${settingsPath} → ${backupPath}`);
  }

  // Merge hooks into settings.json
  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { /* empty/corrupt — start fresh */ }
  }

  const merged = mergeHooks(existing, sourceSettings);
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  console.log(`✓ Merged abmind hooks into ${settingsPath}`);

  // Symlink CLAUDE.md
  ensureSymlink(claudeMdSource, claudeMdTarget, "CLAUDE.md");

  console.log(`\n✅ abmind installed into Claude Code.`);
  console.log(`   MCP server: run "claude mcp add abmind abmind mcp" if not already registered.`);
}

function uninstallClaude(): void {
  const claudeDir = join(homedir(), ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  const backupPath = settingsPath + ".pre-abmind.bak";
  const claudeMdTarget = join(claudeDir, "CLAUDE.md");

  // Remove symlink
  removeSymlink(claudeMdTarget, "CLAUDE.md");

  // Remove abmind hooks from settings
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (settings.hooks) {
        for (const event of Object.keys(settings.hooks)) {
          settings.hooks[event] = (settings.hooks[event] as unknown[]).filter(
            (group: any) => !JSON.stringify(group).includes("abmind")
          );
          if (settings.hooks[event].length === 0) delete settings.hooks[event];
        }
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      }
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      console.log(`✓ Removed abmind hooks from ${settingsPath}`);
    } catch { /* file corrupt or missing — nothing to do */ }
  }

  // Restore backup if settings is now empty
  if (existsSync(backupPath)) {
    console.log(`  Backup available at ${backupPath} (restore manually if needed)`);
  }

  console.log(`\n✅ abmind uninstalled from Claude Code.`);
  console.log(`   MCP: run "claude mcp remove abmind" to deregister the MCP server.`);
}

// ── Gemini CLI ──────────────────────────────────────────────────────────────

function installGemini(): void {
  const geminiDir = join(homedir(), ".gemini");
  const settingsPath = join(geminiDir, "settings.json");
  const backupPath = settingsPath + ".pre-abmind.bak";
  const hooksDir = join(geminiDir, "hooks");
  const geminiMdSource = join(pkgRoot, "gemini-extension", "GEMINI.md");
  const geminiMdTarget = join(geminiDir, "GEMINI.md");
  const sourceHooks = join(pkgRoot, "gemini-extension", "hooks", "hooks.json");

  mkdirSync(geminiDir, { recursive: true });
  mkdirSync(hooksDir, { recursive: true });

  // Backup existing settings (once)
  if (existsSync(settingsPath) && !existsSync(backupPath)) {
    copyFileSync(settingsPath, backupPath);
    console.log(`✓ Backed up ${settingsPath} → ${backupPath}`);
  }

  // Enable tools.enableHooks in settings.json
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { /* start fresh */ }
  }
  if (!(settings as any).tools) (settings as any).tools = {};
  (settings as any).tools.enableHooks = true;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  console.log(`✓ Enabled tools.enableHooks in ${settingsPath}`);

  // Copy hooks.json
  const targetHooksJson = join(hooksDir, "hooks.json");
  if (existsSync(targetHooksJson)) {
    // Merge — don't overwrite existing hooks
    try {
      const existing = JSON.parse(readFileSync(targetHooksJson, "utf-8"));
      const source = JSON.parse(readFileSync(sourceHooks, "utf-8"));
      const merged = mergeHooks(existing, source);
      writeFileSync(targetHooksJson, JSON.stringify(merged, null, 2) + "\n", "utf-8");
      console.log(`✓ Merged abmind hooks into ${targetHooksJson}`);
    } catch {
      copyFileSync(sourceHooks, targetHooksJson);
      console.log(`✓ Copied hooks.json to ${targetHooksJson}`);
    }
  } else {
    copyFileSync(sourceHooks, targetHooksJson);
    console.log(`✓ Copied hooks.json to ${targetHooksJson}`);
  }

  // Symlink GEMINI.md
  ensureSymlink(geminiMdSource, geminiMdTarget, "GEMINI.md");

  console.log(`\n✅ abmind installed into Gemini CLI.`);
}

function uninstallGemini(): void {
  const geminiDir = join(homedir(), ".gemini");
  const settingsPath = join(geminiDir, "settings.json");
  const backupPath = settingsPath + ".pre-abmind.bak";
  const hooksJson = join(geminiDir, "hooks", "hooks.json");
  const geminiMdTarget = join(geminiDir, "GEMINI.md");

  // Remove symlink
  removeSymlink(geminiMdTarget, "GEMINI.md");

  // Remove abmind hooks from hooks.json
  if (existsSync(hooksJson)) {
    try {
      const hooks = JSON.parse(readFileSync(hooksJson, "utf-8"));
      if (hooks.hooks) {
        for (const event of Object.keys(hooks.hooks)) {
          hooks.hooks[event] = (hooks.hooks[event] as unknown[]).filter(
            (group: any) => !JSON.stringify(group).includes("abmind")
          );
          if (hooks.hooks[event].length === 0) delete hooks.hooks[event];
        }
        if (Object.keys(hooks.hooks).length === 0) delete hooks.hooks;
      }
      writeFileSync(hooksJson, JSON.stringify(hooks, null, 2) + "\n", "utf-8");
      console.log(`✓ Removed abmind hooks from ${hooksJson}`);
    } catch { /* nothing to do */ }
  }

  // Remove tools.enableHooks if we set it
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (settings.tools?.enableHooks) {
        delete settings.tools.enableHooks;
        if (Object.keys(settings.tools).length === 0) delete settings.tools;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
        console.log(`✓ Removed tools.enableHooks from ${settingsPath}`);
      }
    } catch { /* nothing to do */ }
  }

  if (existsSync(backupPath)) {
    console.log(`  Backup available at ${backupPath} (restore manually if needed)`);
  }

  console.log(`\n✅ abmind uninstalled from Gemini CLI.`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function mergeHooks(existing: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...existing };
  const sourceHooks = (source as any).hooks ?? {};
  if (!result.hooks) result.hooks = {};

  for (const [event, groups] of Object.entries(sourceHooks)) {
    const existingGroups = (result.hooks as any)[event] ?? [];
    // Skip if abmind hooks already present for this event
    const alreadyHas = existingGroups.some((g: any) => JSON.stringify(g).includes("abmind"));
    if (!alreadyHas) {
      (result.hooks as any)[event] = [...existingGroups, ...(groups as unknown[])];
    }
  }
  return result;
}

function ensureSymlink(source: string, target: string, label: string): void {
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      if (readlinkSync(target) === source) {
        console.log(`✓ ${label} symlink already correct`);
        return;
      }
      unlinkSync(target);
    } else {
      console.log(`  ⚠ ${target} exists (not a symlink) — skipping`);
      return;
    }
  } catch { /* doesn't exist — proceed */ }
  symlinkSync(source, target);
  console.log(`✓ Symlinked ${label} → ${source}`);
}

function removeSymlink(target: string, label: string): void {
  if (!existsSync(target)) return;
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      unlinkSync(target);
      console.log(`✓ Removed ${label} symlink`);
    } else {
      console.log(`  ⚠ ${target} is not a symlink — skipping removal`);
    }
  } catch { /* nothing to do */ }
}

// ── Codex CLI ───────────────────────────────────────────────────────────────

function installCodex(): void {
  const codexDir = join(homedir(), ".codex");
  const hooksTarget = join(codexDir, "hooks.json");
  const codexMdSource = join(pkgRoot, "codex-extension", "CODEX.md");
  const codexMdTarget = join(codexDir, "CODEX.md");
  const sourceHooks = join(pkgRoot, "codex-extension", "hooks.json");

  mkdirSync(codexDir, { recursive: true });

  // Merge hooks into existing hooks.json or create new
  if (existsSync(hooksTarget)) {
    const existing = JSON.parse(readFileSync(hooksTarget, "utf-8"));
    const source = JSON.parse(readFileSync(sourceHooks, "utf-8"));
    // Merge: add abmind hooks to each event
    for (const [event, groups] of Object.entries(source.hooks)) {
      if (!existing.hooks) existing.hooks = {};
      if (!existing.hooks[event]) existing.hooks[event] = [];
      // Remove old abmind entries
      existing.hooks[event] = (existing.hooks[event] as unknown[]).filter(
        (g: any) => !JSON.stringify(g).includes("abmind")
      );
      existing.hooks[event].push(...(groups as unknown[]));
    }
    writeFileSync(hooksTarget, JSON.stringify(existing, null, 2) + "\n", "utf-8");
    console.log(`✓ Merged abmind hooks into ${hooksTarget}`);
  } else {
    copyFileSync(sourceHooks, hooksTarget);
    console.log(`✓ Created ${hooksTarget}`);
  }

  ensureSymlink(codexMdSource, codexMdTarget, "CODEX.md");

  console.log(`\n✅ abmind installed for Codex CLI.`);
  console.log(`   Hooks: SessionStart (wakeup), UserPromptSubmit (recall), Stop (store)`);
}

function uninstallCodex(): void {
  const codexDir = join(homedir(), ".codex");
  const hooksTarget = join(codexDir, "hooks.json");
  const codexMdTarget = join(codexDir, "CODEX.md");

  removeSymlink(codexMdTarget, "CODEX.md");

  if (existsSync(hooksTarget)) {
    try {
      const existing = JSON.parse(readFileSync(hooksTarget, "utf-8"));
      if (existing.hooks) {
        for (const event of Object.keys(existing.hooks)) {
          existing.hooks[event] = (existing.hooks[event] as unknown[]).filter(
            (g: any) => !JSON.stringify(g).includes("abmind")
          );
          if (existing.hooks[event].length === 0) delete existing.hooks[event];
        }
        if (Object.keys(existing.hooks).length === 0) delete existing.hooks;
      }
      writeFileSync(hooksTarget, JSON.stringify(existing, null, 2) + "\n", "utf-8");
      console.log(`✓ Removed abmind hooks from ${hooksTarget}`);
    } catch { /* corrupt — skip */ }
  }

  console.log(`\n✅ abmind uninstalled from Codex CLI.`);
}
