#!/usr/bin/env node
/**
 * abmind-edit — CLI for modifying existing extracted memories.
 *
 * Lookup by memory ID or platform message ID, update any of: content,
 * memory-type, emotion, confidence/trust/integrity/credibility,
 * classification, relevance, topic/tier/valid-to. --dry-run previews.
 */

import { join } from "node:path";
import { appendFileSync } from "node:fs";
import { runCli } from "../src/cli-runner.js";
import type { FlagSpec } from "../src/cli-flags.js";
import type { EditMemoryParams } from "../src/mem-types.js";
import { abmindHome } from "../src/mem-paths.js";

const EDIT_FLAGS: readonly FlagSpec[] = [
  { name: "memory-id", type: "string" },
  { name: "message-id", type: "string" },
  { name: "chat-id", type: "string" },
  { name: "translated", type: "string", aliases: ["--content-en"] },
  { name: "original", type: "string", aliases: ["--content-original"] },
  { name: "keyword", type: "string", aliases: ["--tags"] },
  { name: "memory-type", type: "string" },
  { name: "emotion-score", type: "number" },
  { name: "emotion-tags", type: "string" },
  { name: "emotion-context", type: "string" },
  { name: "confidence", type: "number" },
  { name: "trust", type: "number" },
  { name: "integrity", type: "number" },
  { name: "credibility", type: "number" },
  { name: "classification", type: "number" },
  { name: "relevance-score", type: "string" },
  { name: "caller", type: "string" },
  { name: "user-override", type: "boolean" },
  { name: "dry-run", type: "boolean" },
  { name: "topic", type: "string" },
  { name: "tier", type: "string" },
  { name: "valid-to", type: "string" },
];

/** Map FlagValues to EditMemoryParams + validate. */
function buildEditParams(f: Record<string, string | number | boolean | undefined>): { ok: true; params: EditMemoryParams } | { ok: false; error: string } {
  const params: EditMemoryParams = {};

  if (f["memory-id"] !== undefined) {
    const id = parseInt(String(f["memory-id"]), 10);
    if (!Number.isFinite(id)) return { ok: false, error: "invalid --memory-id" };
    params.memoryId = id;
  }
  if (f["message-id"] !== undefined) {
    const id = parseInt(String(f["message-id"]), 10);
    if (!Number.isFinite(id)) return { ok: false, error: "invalid --message-id" };
    params.messageId = id;
  }
  if (f["chat-id"] !== undefined) params.userId = String(f["chat-id"]);

  if (!params.memoryId && !params.messageId) return { ok: false, error: "--memory-id or --message-id required" };
  if (params.messageId && !params.userId) return { ok: false, error: "--chat-id required with --message-id" };

  if (f["translated"] !== undefined) params.contentEn = String(f["translated"]);
  if (f["original"] !== undefined) params.contentOriginal = String(f["original"]);
  if (f["keyword"] !== undefined) params.keyword = String(f["keyword"]);
  if (f["memory-type"] !== undefined) params.memoryType = String(f["memory-type"]) as EditMemoryParams["memoryType"];
  if (f["emotion-score"] !== undefined) params.emotionScore = Number(f["emotion-score"]);
  if (f["emotion-tags"] !== undefined) params.emotionTags = String(f["emotion-tags"]);
  if (f["emotion-context"] !== undefined) params.emotionContext = String(f["emotion-context"]);
  if (f["confidence"] !== undefined) params.confidence = Number(f["confidence"]);
  if (f["trust"] !== undefined) params.trust = Number(f["trust"]);
  if (f["integrity"] !== undefined) params.integrity = Number(f["integrity"]);
  if (f["credibility"] !== undefined) params.credibility = Number(f["credibility"]);
  if (f["classification"] !== undefined) params.classification = Number(f["classification"]);
  if (f["relevance-score"] !== undefined) params.relevanceScore = String(f["relevance-score"]);
  if (f["caller"] !== undefined) params.caller = String(f["caller"]);
  if (f["user-override"] === true) params.userOverride = true;
  if (f["dry-run"] === true) params.dryRun = true;
  if (f["topic"] !== undefined) params.topic = String(f["topic"]);
  if (f["tier"] !== undefined) params.tier = String(f["tier"]) as "core" | "general";
  if (f["valid-to"] !== undefined) params.validTo = String(f["valid-to"]) || null;

  return { ok: true, params };
}

await runCli(import.meta.url, {
  name: "abmind-edit",
  help: `Usage:
  abmind edit --memory-id <id> --translated "corrected" --caller <name>
  abmind edit --message-id <id> --chat-id <id> --emotion-score <n>
  abmind edit --memory-id <id> --translated "test" --dry-run

Options:
  --memory-id <id>        Lookup by memory ID
  --message-id <id>       Lookup by platform message ID
  --chat-id <id>          Required with --message-id
  --translated <text>     New English content (alias: --content-en)
  --original <text>       New original content (alias: --content-original)
  --keyword <kw>          Update tags (alias: --tags)
  --memory-type <type>    Update memory type
  --emotion-score <n>     Update emotion score
  --confidence <n>        Update confidence
  --trust <n>             Update trust score
  --integrity <n>         Update integrity score
  --credibility <n>       Update credibility score
  --classification <n>    Update classification level
  --relevance-score <v>   Update relevance score (numeric or signed: +5, -3)
  --caller <name>         Caller identifier
  --user-override         Flag as user override
  --dry-run               Preview changes without writing`,
  flags: EDIT_FLAGS,
  handler: async ({ args, backend }) => {
    const validation = buildEditParams(args);
    if (!validation.ok) {
      console.log(JSON.stringify({ ok: false, error: validation.error }));
      process.exitCode = 1; return;
    }
    const { params } = validation;

    // Prompt injection scan on content edits
    if (params.contentEn || params.contentOriginal) {
      const { scanForInjection } = await import("../src/injection-scanner.js");
      const scan = scanForInjection(params.contentEn ?? "");
      if (scan.safe && params.contentOriginal) {
        const scan2 = scanForInjection(params.contentOriginal);
        if (!scan2.safe) Object.assign(scan, scan2);
      }
      if (!scan.safe) {
        const top = scan.flags[0]!;
        const logLine = `${new Date().toLocaleString("sv-SE")} EDIT-BLOCKED category=${top.category} matched="${top.pattern}" caller=${params.caller ?? "unknown"}\n`;
        const logPath = join(abmindHome(), "logs", "prompt_injection.log");
        try { appendFileSync(logPath, logLine); } catch { /* best-effort */ }
        console.log(JSON.stringify({ ok: false, error: `Prompt injection detected (${top.category}): "${top.pattern}"`, blocked: true }));
        process.exitCode = 1; return;
      }
    }

    const result = await backend.editMemory(params);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  },
});
