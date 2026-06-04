#!/usr/bin/env node
/**
 * abmind-store — standalone CLI for agent-initiated memory storage.
 *
 * Persists a memory via MemoryBackend.instantStore(), or dispatches to
 * one of four specialized paths: --boost/--demote, --merge, --reclassify,
 * --delete-ids.
 *
 * Output (success): { "stored": true, "memoriesCount": 1 }
 * Output (error):   { "stored": false, "error": "<reason>" }
 */

import { join } from "node:path";
import { appendFileSync } from "node:fs";
import { runCli } from "../src/cli-runner.js";
import type { FlagSpec } from "../src/cli-flags.js";
import { parseFlags } from "../src/cli-flags.js";
import type { InstantStoreParams } from "../src/mem-types.js";
import { abmindHome } from "../src/mem-paths.js";

// --- Flag spec (shared via cli-flags) ---

export const STORE_FLAGS: readonly FlagSpec[] = [
  { name: "translated", type: "string", aliases: ["--content-en"] },
  { name: "original", type: "string", aliases: ["--content-original"] },
  { name: "memory-type", type: "string" },
  { name: "emotion-score", type: "number" },
  { name: "emotion-tags", type: "string" },
  { name: "emotion-context", type: "string" },
  { name: "user-id", type: "string", aliases: ["--chat-id"] },
  { name: "keyword", type: "string", aliases: ["--tags"] },
  { name: "confidence", type: "number" },
  { name: "topic", type: "string" },
  { name: "source-ids", type: "string" },
  { name: "source", type: "string" },
  { name: "boost", type: "boolean" },
  { name: "demote", type: "boolean" },
  { name: "id", type: "string" },
  { name: "merge", type: "boolean" },
  { name: "merge-ids", type: "string" },
  { name: "classification", type: "number" },
  { name: "trust", type: "number" },
  { name: "integrity", type: "number" },
  { name: "credibility", type: "number" },
  { name: "reclassify", type: "boolean" },
  { name: "user-override", type: "boolean" },
  { name: "delete-ids", type: "string" },
];

// --- Legacy RawArgs shape kept for cli/abmind-store.test.ts compatibility ---

export type RawArgs = {
  contentEn?: string;
  contentOriginal?: string;
  memoryType?: string;
  emotionScore?: string;
  emotionTags?: string;
  emotionContext?: string;
  userId?: string;
  keyword?: string;
  confidence?: string;
  sourceMessageIds?: string;
  source?: string;
  topic?: string;
  boost?: boolean;
  demote?: boolean;
  id?: string;
  merge?: boolean;
  mergeIds?: string;
  classification?: string;
  trust?: string;
  integrity?: string;
  credibility?: string;
  reclassify?: boolean;
  userOverride?: boolean;
  deleteIds?: string;
};

/** Convert the new FlagValues shape to the legacy RawArgs shape. */
function toRaw(f: Record<string, string | number | boolean | undefined>): RawArgs {
  const s = (k: string): string | undefined => f[k] === undefined ? undefined : String(f[k]);
  return {
    contentEn: s("translated"),
    contentOriginal: s("original"),
    memoryType: s("memory-type"),
    emotionScore: s("emotion-score"),
    emotionTags: s("emotion-tags"),
    emotionContext: s("emotion-context"),
    userId: s("user-id"),
    keyword: s("keyword"),
    confidence: s("confidence"),
    sourceMessageIds: s("source-ids"),
    source: s("source"),
    topic: s("topic"),
    boost: f["boost"] === true,
    demote: f["demote"] === true,
    id: s("id"),
    merge: f["merge"] === true,
    mergeIds: s("merge-ids"),
    classification: s("classification"),
    trust: s("trust"),
    integrity: s("integrity"),
    credibility: s("credibility"),
    reclassify: f["reclassify"] === true,
    userOverride: f["user-override"] === true,
    deleteIds: s("delete-ids"),
  };
}

/**
 * Legacy exported parser. Takes raw argv (as from process.argv). Kept as a
 * thin wrapper over parseFlags for cli/abmind-store.test.ts compatibility.
 */
export function parseArgs(argv: string[]): RawArgs {
  return toRaw(parseFlags(argv.slice(2), STORE_FLAGS));
}

/** Validate store-specific business rules. */
export function validateArgs(raw: RawArgs): { ok: true; params: InstantStoreParams } | { ok: false; error: string } {
  if (!raw.contentEn) return { ok: false, error: "content-en is required" };
  if (!raw.contentOriginal) return { ok: false, error: "content-original is required" };
  if (!raw.memoryType) return { ok: false, error: "memory-type is required" };
  if (raw.emotionScore === undefined) return { ok: false, error: "emotion-score is required" };
  if (!raw.userId) return { ok: false, error: "user-id is required" };

  const validTypes = new Set(["fact", "decision", "preference", "event"]);
  if (!validTypes.has(raw.memoryType)) return { ok: false, error: "invalid memory_type" };

  // Source presets: --source internet → trust=0, classification=0
  //                 --source private  → trust=0, classification=2
  let presetTrust: number | undefined;
  let presetClassification: number | undefined;
  if (raw.source === "internet") { presetTrust = 0; presetClassification = 0; }
  else if (raw.source === "private") { presetTrust = 0; presetClassification = 2; }

  return {
    ok: true,
    params: {
      userId: raw.userId,
      contentEn: raw.contentEn,
      contentOriginal: raw.contentOriginal,
      memoryType: raw.memoryType as InstantStoreParams["memoryType"],
      emotionScore: parseInt(raw.emotionScore, 10) || 0,
      emotionTags: raw.emotionTags || undefined,
      emotionContext: raw.emotionContext || undefined,
      keyword: raw.keyword,
      classification: raw.classification ? parseInt(raw.classification, 10) : presetClassification,
      trust: raw.trust ? parseInt(raw.trust, 10) : presetTrust,
      integrity: raw.integrity ? parseInt(raw.integrity, 10) : undefined,
      credibility: raw.credibility ? parseInt(raw.credibility, 10) : undefined,
      topic: raw.topic || undefined,
    },
  };
}

// --- CLI entry ---

await runCli(import.meta.url, {
  name: "abmind-store",
  help: `Usage:
  abmind store --translated <text> --original <text> --memory-type <type> --emotion-score <n> --user-id <id>

Options:
  --translated <text>     English content (alias: --content-en)
  --original <text>       Original content (alias: --content-original)
  --memory-type <type>    fact | decision | preference | event
  --emotion-score <n>     Emotion score
  --user-id <id>          User ID (alias: --chat-id)
  --keyword <kw>          Keyword tag (alias: --tags)
  --confidence <n>        Confidence score
  --source-ids <ids>      Source message IDs
  --classification <n>    Classification level
  --trust <n>             Trust score
  --integrity <n>         Integrity score
  --credibility <n>       Credibility score
  --boost                 Boost relevance (+10) for --id
  --demote                Demote relevance (-10) for --id
  --id <id>               Memory ID (for boost/demote/reclassify)
  --merge                 Merge two memories
  --merge-ids <a,b>       Two IDs to merge
  --reclassify            Reclassify memory (requires --id, --classification)
  --user-override         Flag as user override
  --delete-ids <ids>      Cascade delete by message IDs (requires --user-id)`,
  flags: STORE_FLAGS,
  handler: async ({ args, backend }) => {
    const raw = toRaw(args);

    // --delete-ids path
    if (raw.deleteIds) {
      if (!raw.userId) {
        console.log(JSON.stringify({ deleted: false, error: "--user-id is required with --delete-ids" }));
        process.exitCode = 1; return;
      }
      const ids = raw.deleteIds.split(",").map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));
      if (ids.length === 0) {
        console.log(JSON.stringify({ deleted: false, error: "no valid IDs in --delete-ids" }));
        process.exitCode = 1; return;
      }
      const result = await backend.cascadeDelete(ids, raw.userId);
      console.log(JSON.stringify({ deleted: true, ...result }));
      return;
    }

    // --reclassify path
    if (raw.reclassify) {
      if (!raw.id || !raw.classification) {
        console.log(JSON.stringify({ stored: false, error: "--id and --classification are required with --reclassify" }));
        process.exitCode = 1; return;
      }
      const id = parseInt(raw.id, 10);
      const level = parseInt(raw.classification, 10);
      const result = await backend.reclassifyMemory(id, level, raw.userOverride ?? false);
      console.log(JSON.stringify(result));
      return;
    }

    // --boost / --demote path
    if (raw.boost || raw.demote) {
      if (!raw.id) {
        console.log(JSON.stringify({ stored: false, error: "--id is required with --boost/--demote" }));
        process.exitCode = 1; return;
      }
      const id = parseInt(raw.id, 10);
      const delta = raw.boost ? 10 : -10;
      await backend.adjustRelevance(id, delta);
      console.log(JSON.stringify({ stored: true, adjusted: { id, delta } }));
      return;
    }

    // --merge path
    if (raw.merge) {
      if (!raw.mergeIds) {
        console.log(JSON.stringify({ stored: false, error: "--merge-ids is required with --merge" }));
        process.exitCode = 1; return;
      }
      const ids = raw.mergeIds.split(",").map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));
      if (ids.length !== 2) {
        console.log(JSON.stringify({ stored: false, error: "--merge-ids must be exactly 2 comma-separated IDs" }));
        process.exitCode = 1; return;
      }
      const result = await backend.mergeMemories(ids[0]!, ids[1]!);
      console.log(JSON.stringify(result));
      return;
    }

    // Normal store path
    const validation = validateArgs(raw);
    if (!validation.ok) {
      console.log(JSON.stringify({ stored: false, error: validation.error }));
      process.exitCode = 1; return;
    }

    // Prompt injection scan for trust < 5
    const trust = validation.params.trust ?? 0;
    if (trust < 5) {
      const { scanForInjection } = await import("../src/injection-scanner.js");
      const scan = scanForInjection(validation.params.contentEn);
      if (scan.safe && validation.params.contentOriginal) {
        const scan2 = scanForInjection(validation.params.contentOriginal);
        if (!scan2.safe) Object.assign(scan, scan2);
      }
      if (!scan.safe) {
        const top = scan.flags[0]!;
        const logLine = `${new Date().toLocaleString("sv-SE")} BLOCKED category=${top.category} matched="${top.pattern}" score=${scan.score} trust=${trust} content="${validation.params.contentEn.slice(0, 120)}"\n`;
        const logPath = join(abmindHome(), "logs", "prompt_injection.log");
        try { appendFileSync(logPath, logLine); } catch { /* best-effort */ }
        console.log(JSON.stringify({ stored: false, error: `Prompt injection detected (${top.category}): "${top.pattern}"`, blocked: true }));
        process.exitCode = 1; return;
      }
    }

    const result = await backend.instantStore({ ...validation.params, createdBy: "cli:store" });
    console.log(JSON.stringify(result));
  },
});
