#!/usr/bin/env node
/**
 * abmind-recall — CLI wrapper for the 4-layer recall engine.
 *
 * Output: JSON to stdout (results). Stderr gets a hit-rate summary.
 */

import { runCli } from "../src/cli-runner.js";
import type { FlagSpec } from "../src/cli-flags.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const RECALL_FLAGS: readonly FlagSpec[] = [
  { name: "translated", type: "string", aliases: ["--keywords"] },
  { name: "original", type: "string" },
  { name: "chat-id", type: "string" },
  { name: "stages", type: "string" },
  { name: "limit", type: "number" },
  { name: "max-classification", type: "number" },
  { name: "time-start", type: "number" },
  { name: "time-end", type: "number" },
  { name: "topic", type: "string" },
  { name: "emotion", type: "string" },
  { name: "pool", type: "string" },
  { name: "include-expired", type: "boolean" },
  { name: "full", type: "boolean" },
];

await runCli(import.meta.url, {
  name: "abmind-recall",
  help: `Usage:
  abmind recall --translated "kw1,kw2" --chat-id <id>
  abmind recall --translated "kw" --original "kw" --chat-id <id>
  abmind recall --translated "kw" --chat-id <id> --stages Sf,Ss

Options:
  --translated <kw>        Comma-separated keywords (alias: --keywords)
  --original <kw>          Original-language keyword
  --chat-id <id>           Chat ID (required)
  --stages <Sf,Ss>         Comma-separated stages (Sf, Ss, Se, S6)
  --limit <n>              Max results (default 10, max 50)
  --max-classification <n> Max classification level (default 2)
  --time-start <epoch>     Filter by start time
  --time-end <epoch>       Filter by end time
  --topic <name>           Topic filter
  --emotion <name>         Emotion filter
  --pool core|general      Tier filter
  --include-expired        Include expired memories
  --full                   Full resolution output`,
  flags: RECALL_FLAGS,
  handler: async ({ args, backend }) => {
    const translated = args["translated"] !== undefined
      ? String(args["translated"]).split(",").map(s => s.trim()).filter(Boolean)
      : [];
    const userId = args["chat-id"] !== undefined ? String(args["chat-id"]) : process.env["ABMIND_USER_ID"];

    if (!translated.length || !userId) {
      console.error('Usage: abmind recall --translated "kw1,kw2" --chat-id <id> [--original <kw>]');
      if (!userId) console.error("  Hint: set ABMIND_USER_ID env var or pass --chat-id");
      process.exitCode = 1; return;
    }

    const stages = args["stages"] !== undefined
      ? String(args["stages"]).split(",").map(s => s.trim()).filter(Boolean)
      : undefined;
    const rawLimit = args["limit"] !== undefined ? Number(args["limit"]) : DEFAULT_LIMIT;
    const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit || DEFAULT_LIMIT));
    const maxClassification = args["max-classification"] !== undefined
      ? Math.min(2, Math.max(0, Number(args["max-classification"])))
      : 2;
    const pool = args["pool"] !== undefined ? String(args["pool"]) : undefined;
    const tier: "core" | "general" | undefined =
      pool === "core" ? "core" : pool === "general" ? "general" : undefined;

    const result = await backend.recall({
      translated,
      original: args["original"] !== undefined ? String(args["original"]) : undefined,
      userId,
      limit,
      maxClassification,
      timeStart: args["time-start"] !== undefined ? Number(args["time-start"]) : undefined,
      timeEnd: args["time-end"] !== undefined ? Number(args["time-end"]) : undefined,
      stages,
      topic: args["topic"] !== undefined ? String(args["topic"]) : undefined,
      tier,
      includeExpired: args["include-expired"] === true,
      resolution: args["full"] === true ? "full" : undefined,
    });

    console.log(JSON.stringify(result.results, null, 2));

    const stageSummary = Object.entries(result.stages).map(([k, v]) => `${k}=${v.hits.length}`).join(" ");
    const query = translated.join(" ");
    console.error(`[recall] query="${query}" ${stageSummary} short_circuit=${result.shortCircuitAfter ?? "none"} total=${result.results.length}`);

    const expandable = result.results.filter(r => r.source_ids);
    if (expandable.length) {
      const allIds = expandable.map(r => r.source_ids).join(",");
      console.error(`\nHint: ${expandable.length} result(s) have source message IDs. Expand with:\n  abmind expand --ids ${allIds}`);
    }
  },
});
