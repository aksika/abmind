#!/usr/bin/env node
/**
 * abmind sleep-apply — promote or demote memories.
 * Delta: ±10 (matches abmind-store --boost/--demote and MCP memory_edit).
 */
import { runCli } from "../src/cli-runner.js";
import type { FlagSpec } from "../src/cli-flags.js";

const FLAGS: readonly FlagSpec[] = [
  { name: "promote", type: "string" },
  { name: "demote", type: "string" },
  { name: "dry-run", type: "boolean" },
];

const parseIds = (s: string | undefined): number[] =>
  s ? s.split(",").map(x => parseInt(x.trim(), 10)).filter(n => !isNaN(n)) : [];

await runCli(import.meta.url, {
  name: "abmind-sleep-apply",
  help: `Usage:
  abmind sleep-apply --promote <ids> --demote <ids> [--dry-run]

Options:
  --promote <ids>  Comma-separated memory IDs to boost (+10 relevance)
  --demote <ids>   Comma-separated memory IDs to demote (-10 relevance)
  --dry-run        Preview without writing`,
  flags: FLAGS,
  handler: async ({ args, backend }) => {
    const promoteIds = parseIds(args["promote"] !== undefined ? String(args["promote"]) : undefined);
    const demoteIds = parseIds(args["demote"] !== undefined ? String(args["demote"]) : undefined);
    const dryRun = args["dry-run"] === true;

    if (promoteIds.length === 0 && demoteIds.length === 0) {
      console.error("Usage: abmind sleep-apply --promote <ids> --demote <ids> [--dry-run]");
      process.exitCode = 1; return;
    }

    for (const id of promoteIds) {
      if (dryRun) console.log(`[DRY-RUN] Would promote memory #${id}`);
      else { await backend.adjustRelevance(id, 10); console.log(`✅ Promoted memory #${id}`); }
    }
    for (const id of demoteIds) {
      if (dryRun) console.log(`[DRY-RUN] Would demote memory #${id}`);
      else { await backend.adjustRelevance(id, -10); console.log(`✅ Demoted memory #${id}`); }
    }
  },
});
