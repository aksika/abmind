#!/usr/bin/env node
/**
 * abmind-retro-extract — Extract durable facts from retrospective files.
 *
 * Parses retro markdown, extracts bullets from "What did I learn?" (facts)
 * and "How can I improve?" (decisions), stores via instantStore().
 */

import { readdirSync, readFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/cli-runner.js";
import type { FlagSpec } from "../src/cli-flags.js";
import { abmindHome } from "../src/mem-paths.js";
import type { InstantStoreParams } from "../src/mem-types.js";

const TAG = "retro-extract";

interface ExtractedItem {
  content: string;
  memoryType: "fact" | "decision";
}

/** Extract bullets from a section by header substring. */
function extractSection(text: string, headerMatch: string): string[] {
  const lines = text.split("\n");
  let inSection = false;
  const bullets: string[] = [];
  for (const line of lines) {
    if (line.startsWith("## ") && line.toLowerCase().includes(headerMatch.toLowerCase())) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith("## ")) break;
    if (inSection && line.startsWith("- ")) {
      const content = line.slice(2).trim();
      if (content.length > 10) bullets.push(content);
    }
  }
  return bullets;
}

/** Parse a retro file and extract facts + decisions. */
export function parseRetro(content: string): ExtractedItem[] {
  const items: ExtractedItem[] = [];
  for (const bullet of extractSection(content, "what did i learn")) {
    items.push({ content: bullet, memoryType: "fact" });
  }
  for (const bullet of extractSection(content, "how can i improve")) {
    items.push({ content: bullet, memoryType: "decision" });
  }
  return items;
}

const RETRO_FLAGS: readonly FlagSpec[] = [
  { name: "dry-run", type: "boolean" },
  { name: "verbose", type: "boolean" },
];

await runCli(import.meta.url, {
  name: "abmind-retro-extract",
  help: `Usage:
  abmind retro-extract [--dry-run] [--verbose]

Parses retrospective files in $ABMIND_HOME/memory/retrospectives/,
extracts bullets from the "What did I learn?" and "How can I improve?"
sections, and stores them as facts/decisions. Renames processed files
to .done suffix on success (unless --dry-run).`,
  flags: RETRO_FLAGS,
  handler: async ({ args, backend }) => {
    const dryRun = args["dry-run"] === true;
    const verbose = args["verbose"] === true;
    const retroDir = join(abmindHome(), "memory", "retrospectives");

    if (!existsSync(retroDir)) {
      if (verbose) console.log(`[${TAG}] No retrospectives directory`);
      return;
    }

    const files = readdirSync(retroDir).filter(f => f.startsWith("retro_") && f.endsWith(".md")).sort();
    if (files.length === 0) {
      if (verbose) console.log(`[${TAG}] No unprocessed retro files`);
      return;
    }

    let totalStored = 0;
    for (const file of files) {
      const content = readFileSync(join(retroDir, file), "utf-8");
      const items = parseRetro(content);
      if (verbose) console.log(`[${TAG}] ${file}: ${items.length} items`);

      for (const item of items) {
        if (dryRun) {
          console.log(`[DRY-RUN] ${item.memoryType}: ${item.content.slice(0, 100)}`);
          continue;
        }
        const resolvedUserId = process.env["ABMIND_USER_ID"];
        if (!resolvedUserId) { console.error("ABMIND_USER_ID env var required"); process.exit(1); }
        const params: InstantStoreParams = {
          userId: resolvedUserId,
          contentEn: item.content,
          contentOriginal: item.content,
          memoryType: item.memoryType,
          emotionScore: 0,
          confidence: 3,
          classification: 0,
        };
        const result = await backend.instantStore(params);
        if (result.stored) totalStored++;
        if (verbose) console.log(`[${TAG}]   ${result.stored ? "✓" : "✗"} ${item.memoryType}: ${item.content.slice(0, 80)}`);
      }

      if (!dryRun) {
        renameSync(join(retroDir, file), join(retroDir, file.replace(".md", ".done")));
      }
    }

    if (!dryRun) {
      console.log(`[${TAG}] Stored ${totalStored} items from ${files.length} retro file(s)`);
    }
  },
});
