#!/usr/bin/env node
/**
 * abmind hook-preToolUse — Kiro CLI preToolUse hook (#634).
 *
 * Security gate: blocks direct writes to abmind's memory DB.
 * Pure string matching — no I/O, no async beyond stdin read.
 * Exit 0 = allow, exit 2 = block (STDERR returned to LLM).
 */

import { runCliRaw } from "../src/cli-runner-raw.js";
import { hooksDisabled, readStdinJson, ensureHooksDir } from "../src/hook-helpers.js";

interface PreToolUsePayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

const BLOCKED_DB_PATTERNS = [
  /memory\.db/,
  /memory\/memory/,
  /\.abmind\/memory/,
];

await runCliRaw(import.meta.url, {
  name: "abmind-hook-preToolUse",
  help: `Usage:
  abmind hook-preToolUse

Kiro CLI preToolUse hook. Blocks direct writes to abmind's memory DB.
Exit 0 = allow, exit 2 = block.

Env var: ABMIND_HOOKS_DISABLED=true disables all hooks.`,
  flags: [],
  handler: async () => {
    ensureHooksDir();
    if (hooksDisabled()) { process.exit(0); }

    try {
      const payload = await readStdinJson<PreToolUsePayload>();
      if (!payload?.tool_name) { process.exit(0); }

      const toolName = payload.tool_name;
      const input = payload.tool_input ?? {};

      if (toolName === "execute_bash" || toolName === "shell") {
        const cmd = String(input.command ?? "");
        for (const pat of BLOCKED_DB_PATTERNS) {
          if (pat.test(cmd)) {
            process.stderr.write(`🛡️ Blocked: direct access to abmind memory.db is not allowed. Use abmind CLI commands instead.\n`);
            process.exit(2);
          }
        }
      }

      if (toolName === "fs_write" || toolName === "write") {
        const path = String(input.path ?? "");
        if (path.includes(".abmind/memory")) {
          process.stderr.write(`🛡️ Blocked: direct writes to ~/.abmind/memory/ are not allowed. Use abmind CLI commands instead.\n`);
          process.exit(2);
        }
      }
    } catch {
      // Never block on hook failure
    }

    process.exit(0);
  },
});
