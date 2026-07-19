#!/usr/bin/env node
/**
 * abmind hook recall — Kiro CLI userPromptSubmit / Gemini BeforeAgent hook (#344).
 *
 * Reads JSON from stdin: { hook_event_name, cwd, prompt }
 * Writes relevant memories to stdout (capped) for context injection.
 * Also writes the prompt to a sidecar file so the `stop` hook can record
 * a full turn. Exit 0 always (never blocks chat).
 *
 * Translation awareness: the prompt is split across `translated` (English
 * tokens extracted heuristically) and `original` (raw prompt). Sf's
 * three-query fan-out handles both paths. See
 * abproject/docs/plans/abmind-hook-recall-translation.md.
 */

import { runCliRaw } from "../src/cli-runner-raw.js";
import { getMemoryClient, closeClient, isClient } from "../src/backend-factory.js";
import { hooksDisabled, logHookError, readStdinJson, ensureHooksDir } from "../src/hook-helpers.js";
import { hookSidecarPath } from "../src/mem-paths.js";
import { writeFileSync } from "node:fs";
import { buildHookAdapterContext, buildHookClientContext } from "./hook-lifecycle-adapter.js";

const DEFAULT_LIMIT = 5;
const DEFAULT_MAX_CHARS = 2000;

interface PromptSubmitPayload {
  hook_event_name?: string;
  cwd?: string;
  prompt?: string;
}

await runCliRaw(import.meta.url, {
  name: "abmind-hook-recall",
  help: `Usage:
  abmind hook recall

Kiro CLI userPromptSubmit hook. Reads hook event JSON from stdin, runs
recall on the prompt, outputs top matches for context injection.

Also writes the prompt to a sidecar file so the \`stop\` hook can record
the full turn.

Exits 0 unconditionally. SECRET memories (classification=3) are never
surfaced here — only explicit CLI/agent queries can reach them.

Env vars:
  ABMIND_HOOKS_DISABLED         disable all hooks (default: false)
  ABMIND_HOOK_RECALL_LIMIT      max results (default: 5)
  ABMIND_HOOK_RECALL_MAX_CHARS  max output chars (default: 2000)`,
  flags: [],
  handler: async () => {
    ensureHooksDir();
    if (hooksDisabled()) { process.exit(0); }

    try {
      const payload = await readStdinJson<PromptSubmitPayload>();
      const prompt = payload?.prompt?.trim();
      if (!prompt) { process.exit(0); }

      // Write sidecar FIRST so even a recall failure doesn't drop the prompt for the stop hook
      try {
        writeFileSync(hookSidecarPath(), prompt, "utf-8");
      } catch (err) {
        logHookError("recall:sidecar", err);
      }

      const limit = Math.max(1, Math.min(50, Number(process.env.ABMIND_HOOK_RECALL_LIMIT ?? DEFAULT_LIMIT)));
      const maxChars = Math.max(100, Number(process.env.ABMIND_HOOK_RECALL_MAX_CHARS ?? DEFAULT_MAX_CHARS));

      const client = await getMemoryClient(false);
      try {
        const ctx = isClient(client) ? buildHookClientContext(client) : buildHookAdapterContext(client);
        if (!ctx) { process.exit(0); }

        const result = await ctx.recall({ query: prompt!, limit, maxChars });

        if (result.hits.length === 0) { process.exit(0); }

        const { writeHookOutput } = await import("./hook-output.js");
        writeHookOutput(result.context, ctx.format);
      } finally {
        closeClient(client);
      }
    } catch (err) {
      logHookError("recall", err);
    }

    process.exit(0);
  },
});
