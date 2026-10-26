#!/usr/bin/env node
/**
 * abmind-recall — CLI wrapper for the owned recall contract.
 *
 * Each invocation selects one profile explicitly and prints the owner
 * packet: status, owner-rendered text, and source-safe refs. No
 * newest-row/legacy fallback exists.
 */

import { runCli } from "../src/cli-runner.js";
import type { FlagSpec, FlagValues } from "../src/cli-flags.js";
import type { MemoryBackend } from "../src/memory-backend.js";
import { OWNED_RECALL_CONTRACT, OWNED_PROFILE_BOUNDS } from "../src/owned-recall-contract.js";
import { abmindHome } from "../src/mem-paths.js";
import { resolveOwnerSnapshot } from "../src/user-utils.js";

const RECALL_FLAGS: readonly FlagSpec[] = [
  { name: "profile", type: "string" },
  { name: "raw-turn", type: "string" },
  { name: "text", type: "string" },
  { name: "keywords", type: "string" },
  { name: "user-id", type: "string", aliases: ["--chat-id"] },
  { name: "max-items", type: "number" },
  { name: "max-output-bytes", type: "number" },
  { name: "deadline-ms", type: "number" },
  { name: "max-classification", type: "number" },
  { name: "time-start", type: "number" },
  { name: "time-end", type: "number" },
  { name: "memory-type", type: "string" },
  { name: "scope", type: "string" },
  { name: "as-of", type: "string" },
  { name: "continuation", type: "string" },
];

/** CLI body, exported for focused tests. */
export async function executeRecallCli({ args, backend }: { args: FlagValues; backend: MemoryBackend }): Promise<void> {
  const profileArg = args["profile"] !== undefined ? String(args["profile"]) : "recall_normal";
  if (profileArg !== "recall_fast" && profileArg !== "recall_normal" && profileArg !== "recall_full") {
    console.error('Usage: --profile must be recall_fast, recall_normal, or recall_full');
    process.exitCode = 1; return;
  }
  const bounds = OWNED_PROFILE_BOUNDS[profileArg];

  // #1928 M4 — the CLI resolves the installation principal from the
  // manifest, not a user flag/env override.
  let principal: string;
  try {
    principal = resolveOwnerSnapshot(abmindHome());
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1; return;
  }
  if (args["user-id"] !== undefined && String(args["user-id"]) !== principal) {
    console.error(`--user-id must be the installation primary (${principal})`);
    process.exitCode = 1; return;
  }

  const keywords = args["keywords"] !== undefined
    ? String(args["keywords"]).split(",").map(s => s.trim()).filter(Boolean)
    : [];
  const text = args["text"] !== undefined ? String(args["text"]) : undefined;
  const rawTurn = args["raw-turn"] !== undefined ? String(args["raw-turn"]) : undefined;

  if (profileArg === "recall_fast") {
    if (!rawTurn || !rawTurn.trim()) {
      console.error('Usage: abmind recall --profile recall_fast --raw-turn "<verbatim turn>"');
      process.exitCode = 1; return;
    }
  } else if ((!text || !text.trim()) && keywords.length === 0) {
    console.error(`Usage: abmind recall --profile ${profileArg} --text "<explicit anchor>" [--keywords "kw1,kw2"]`);
    process.exitCode = 1; return;
  }

  const maxItems = args["max-items"] !== undefined
    ? Math.min(bounds.maxItems, Math.max(1, Math.floor(Number(args["max-items"]))))
    : bounds.maxItems;
  const maxOutputBytes = args["max-output-bytes"] !== undefined
    ? Math.min(bounds.maxOutputBytes, Math.max(1, Math.floor(Number(args["max-output-bytes"]))))
    : bounds.maxOutputBytes;
  const capacity: { maxItems: number; maxOutputBytes: number; deadlineMs?: number } = {
    maxItems,
    maxOutputBytes,
    ...(args["deadline-ms"] !== undefined
      ? { deadlineMs: Math.min(bounds.workDeadlineMs, Math.max(1, Math.floor(Number(args["deadline-ms"])))) }
      : {}),
  };
  const classificationCeiling = args["max-classification"] !== undefined
    ? Math.min(2, Math.max(0, Math.floor(Number(args["max-classification"]))))
    : 2;

  const packet = await backend.recall({
    contract: OWNED_RECALL_CONTRACT,
    profile: profileArg,
    identity: { principal },
    ...(profileArg === "recall_fast"
      ? { rawTurn: rawTurn!.trim() }
      : { query: { ...(text !== undefined ? { text } : {}), ...(keywords.length > 0 ? { keywords } : {}) } }),
    filters: {
      ...(args["memory-type"] !== undefined ? { memoryType: String(args["memory-type"]) } : {}),
      ...(args["scope"] !== undefined ? { scope: String(args["scope"]) } : {}),
      ...(args["time-start"] !== undefined ? { timeStart: Number(args["time-start"]) } : {}),
      ...(args["time-end"] !== undefined ? { timeEnd: Number(args["time-end"]) } : {}),
      classificationCeiling,
      ...(args["as-of"] !== undefined ? { asOf: String(args["as-of"]) } : {}),
    },
    capacity,
    ...(args["continuation"] !== undefined ? { continuation: String(args["continuation"]) } : {}),
  });

  console.log(JSON.stringify(packet, null, 2));
  const outcomes = Object.entries(packet.stageOutcomes)
    .map(([stage, outcome]) => `${stage}:${outcome.status}/${outcome.hitCount}`)
    .join(" ");
  console.error(`[recall] profile=${packet.profile} status=${packet.status} items=${packet.items.length} outcomes="${outcomes}"`);
  if (packet.continuation !== undefined) {
    console.error(`[recall] continuation available for the next page`);
  }
}

await runCli(import.meta.url, {
  name: "abmind-recall",
  help: `Usage:
  abmind recall --profile recall_fast --raw-turn "<verbatim turn>"
  abmind recall --profile recall_normal --text "<explicit anchor>" [--keywords "kw1,kw2"]
  abmind recall --profile recall_full --text "<anchor>" --keywords "kw1,kw2" [--continuation <handle>]

Options:
  --profile recall_fast|recall_normal|recall_full   Required logical profile
  --raw-turn <turn>        Verbatim current turn (fast only)
  --text <anchor>          Explicit anchor text (normal/full)
  --keywords <kw>          Comma-separated explicit keywords (normal/full)
  --max-items <n>          Selected items (bounded by the profile)
  --max-output-bytes <n>   Rendered UTF-8 bytes (bounded by the profile)
  --deadline-ms <n>        Owner work deadline (bounded by the profile)
  --max-classification <n> Classification ceiling 0-2 (default 2)
  --time-start/--time-end <epoch>  Caller time bounds
  --memory-type/--scope <v> Narrowing filters
  --as-of <date>           Historical resolution (normal/full)
  --continuation <handle>  Owner-issued page handle (normal/full)`,
  flags: RECALL_FLAGS,
  handler: executeRecallCli,
});
