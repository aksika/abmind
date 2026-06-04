#!/usr/bin/env node
/**
 * abmind hook-postToolUse — Kiro CLI postToolUse hook (#634).
 *
 * Captures tool usage summaries into a sidecar file for richer memory.
 * The stop hook reads this sidecar and includes it in the recorded turn.
 * Exit 0 always — never blocks.
 */

import { runCliRaw } from "../src/cli-runner-raw.js";
import { hooksDisabled, logHookError, readStdinJson, ensureHooksDir } from "../src/hook-helpers.js";
import { abmindHooksDir, hookSidecarKey } from "../src/mem-paths.js";
import { join } from "node:path";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const MAX_ENTRIES = 50;
const MAX_LINE = 120;

interface PostToolUsePayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

function toolsSidecarPath(): string {
  return join(abmindHooksDir(), `tools-${hookSidecarKey()}.sidecar`);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + "...";
}

await runCliRaw(import.meta.url, {
  name: "abmind-hook-postToolUse",
  help: `Usage:
  abmind hook-postToolUse

Kiro CLI postToolUse hook. Captures tool usage into a sidecar file.
The stop hook includes this in the recorded turn for richer memory.

Env var: ABMIND_HOOKS_DISABLED=true disables all hooks.`,
  flags: [],
  handler: async () => {
    ensureHooksDir();
    if (hooksDisabled()) { process.exit(0); }

    try {
      const payload = await readStdinJson<PostToolUsePayload>();
      if (!payload?.tool_name) { process.exit(0); }

      const toolName = payload.tool_name;
      const input = payload.tool_input ?? {};
      let line: string | null = null;

      if (toolName === "execute_bash" || toolName === "shell") {
        const cmd = String(input.command ?? "").replace(/\s+/g, " ").trim();
        if (cmd) line = `bash: ${truncate(cmd, MAX_LINE)}`;
      } else if (toolName === "fs_write" || toolName === "write") {
        const path = String(input.path ?? "");
        const op = String(input.command ?? "write");
        if (path) line = `write: ${path} (${op})`;
      } else if (toolName === "use_aws" || toolName === "aws") {
        const svc = String(input.service_name ?? "");
        const op = String(input.operation_name ?? "");
        if (svc) line = `aws: ${svc} ${op}`;
      } else if (toolName === "use_subagent") {
        const content = input.content as { subagents?: Array<{ query?: string }> } | undefined;
        const query = content?.subagents?.[0]?.query ?? "";
        if (query) line = `subagent: ${truncate(query.replace(/\s+/g, " ").trim(), MAX_LINE)}`;
      }

      if (line) {
        const sidecar = toolsSidecarPath();
        appendFileSync(sidecar, line + "\n", "utf-8");

        // Cap at MAX_ENTRIES
        const content = readFileSync(sidecar, "utf-8");
        const lines = content.split("\n").filter(Boolean);
        if (lines.length > MAX_ENTRIES) {
          writeFileSync(sidecar, lines.slice(-MAX_ENTRIES).join("\n") + "\n", "utf-8");
        }
      }
    } catch (err) {
      logHookError("postToolUse", err);
    }

    process.exit(0);
  },
});
