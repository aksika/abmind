#!/usr/bin/env node
/**
 * abmind migrate-openclaw — one-time import of OpenClaw session transcripts.
 *
 * Usage:
 *   abmind migrate-openclaw <dir>                    Import all .jsonl files
 *   abmind migrate-openclaw <file> --chat-id <id>    Import single file with explicit chatId
 *   abmind migrate-openclaw <dir> --strict           Error on first malformed line
 *   abmind migrate-openclaw <dir> --budget-chars N   Override budget cap (default 100000)
 */

import { createReadStream, statSync, readdirSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { createInterface } from "node:readline";
import { MemoryManager } from "../src/memory-manager.js";
import { loadMemoryConfig } from "../src/memory-config.js";

// ── Config ────────────────────────────────────────────────────────────────

const DEFAULT_BUDGET_CHARS = 100_000;
const TIMESTAMP_SPACING_MS = 1000;

// ── Types ─────────────────────────────────────────────────────────────────

interface ParsedMessage {
  role: "user" | "assistant";
  text: string;
}

// ── Parsing ───────────────────────────────────────────────────────────────

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n");
}

function extractMessage(value: unknown): ParsedMessage | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;

  // Unwrap {type:"message", message:{...}} wrapper
  let msg = obj;
  if ("message" in obj && obj.type === "message" && typeof obj.message === "object" && obj.message) {
    msg = obj.message as Record<string, unknown>;
  }

  const role = msg.role as string | undefined;
  if (role !== "user" && role !== "assistant") return null; // skip tool_result + others

  const text = extractText(msg.content);
  if (!text.trim()) return null;

  return { role, text };
}

async function readSessionFile(filePath: string, strict: boolean): Promise<{ messages: ParsedMessage[]; errors: number }> {
  const messages: ParsedMessage[] = [];
  let errors = 0;

  const firstChar = await getFirstNonWhitespaceChar(filePath);
  if (firstChar === "[") {
    // JSON array mode
    const { readFileSync } = await import("node:fs");
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          const msg = extractMessage(entry);
          if (msg) messages.push(msg);
        }
      }
    } catch (err) {
      if (strict) throw err;
      errors++;
    }
  } else {
    // JSONL mode
    const stream = createReadStream(filePath, { encoding: "utf-8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        const msg = extractMessage(parsed);
        if (msg) messages.push(msg);
      } catch (err) {
        if (strict) { stream.destroy(); throw err; }
        errors++;
      }
    }
  }

  return { messages, errors };
}

async function getFirstNonWhitespaceChar(filePath: string): Promise<string | null> {
  const stream = createReadStream(filePath, { encoding: "utf-8", end: 1024 });
  for await (const chunk of stream) {
    const trimmed = (chunk as string).trimStart();
    if (trimmed.length > 0) { stream.destroy(); return trimmed[0]!; }
  }
  return null;
}

// ── Budget cap ────────────────────────────────────────────────────────────

function capByBudget(messages: ParsedMessage[], maxChars: number): ParsedMessage[] {
  let total = 0;
  const kept: ParsedMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    total += messages[i]!.text.length;
    if (total > maxChars) break;
    kept.unshift(messages[i]!);
  }
  return kept;
}

// ── ChatId derivation ─────────────────────────────────────────────────────

function chatIdFromFilename(filename: string): string {
  return basename(filename, extname(filename));
}

// ── Main ──────────────────────────────────────────────────────────────────

export async function migrateOpenclaw(args: string[]): Promise<void> {
  // Parse args
  const positional: string[] = [];
  let chatIdOverride: string | undefined;
  let strict = false;
  let budgetChars = DEFAULT_BUDGET_CHARS;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--chat-id" && i + 1 < args.length) { chatIdOverride = args[++i]; }
    else if (arg === "--strict") { strict = true; }
    else if (arg === "--budget-chars" && i + 1 < args.length) { budgetChars = parseInt(args[++i]!, 10) || DEFAULT_BUDGET_CHARS; }
    else if (!arg.startsWith("--")) { positional.push(arg); }
  }

  const target = positional[0];
  if (!target) {
    console.error("Usage: abmind migrate-openclaw <dir-or-file> [--chat-id <id>] [--strict] [--budget-chars N]");
    process.exitCode = 1;
    return;
  }

  if (!existsSync(target)) {
    console.error(`Error: path not found: ${target}`);
    process.exitCode = 1;
    return;
  }

  const stat = statSync(target);
  const isDir = stat.isDirectory();

  if (chatIdOverride && isDir) {
    console.error("Error: --chat-id is only valid with a single file, not a directory.");
    process.exitCode = 1;
    return;
  }

  // Collect files
  const files: string[] = isDir
    ? readdirSync(target).filter(f => f.endsWith(".jsonl")).map(f => join(target, f))
    : [target];

  if (files.length === 0) {
    console.log("No .jsonl files found.");
    return;
  }

  // Init memory (embeddings disabled for migration performance)
  process.env.EMBEDDING_ENABLED = "false";
  const config = loadMemoryConfig();
  const memory = new MemoryManager(config);
  await memory.initialize({ skipEmbeddingCheck: true });

  let imported = 0;
  let skipped = 0;

  for (const file of files) {
    const filename = basename(file);
    const chatId = chatIdOverride ?? chatIdFromFilename(filename);
    const isTopic = filename.includes("-topic-");

    try {
      const { messages, errors } = await readSessionFile(file, strict);
      if (messages.length === 0) {
        console.log(`  ${filename} → skipped (0 text messages found${errors > 0 ? `, ${errors} parse errors` : ""})`);
        skipped++;
        continue;
      }

      const capped = capByBudget(messages, budgetChars);
      const fileMtime = statSync(file).mtimeMs;

      // Insert in a single synchronous transaction
      const db = (memory as any).db;
      if (!db) { console.error(`  ${filename} → error: memory DB not initialized`); skipped++; continue; }

      db.transaction(() => {
        for (let i = 0; i < capped.length; i++) {
          const msg = capped[i]!;
          const timestamp = Math.floor(fileMtime - (capped.length - 1 - i) * TIMESTAMP_SPACING_MS);
          memory.recordMessage({
            role: msg.role,
            content: msg.text,
            timestamp,
            userId: chatId,
            sessionId: chatId,
          });
        }
      })();

      const startDate = new Date(fileMtime - (capped.length - 1) * TIMESTAMP_SPACING_MS).toISOString().slice(0, 10);
      const endDate = new Date(fileMtime).toISOString().slice(0, 10);
      const topicNote = isTopic ? " (topic sub-transcript, imported as separate chat)" : "";
      console.log(`  ${filename} → ${capped.length} messages imported (chat: ${chatId}, span: ${startDate} to ${endDate})${topicNote}`);
      imported++;
    } catch (err) {
      console.error(`  ${filename} → error: ${err instanceof Error ? err.message : String(err)}`);
      skipped++;
    }
  }

  memory.close();
  console.log(`\nDone: ${imported} session${imported !== 1 ? "s" : ""} imported, ${skipped} skipped.`);
  if (imported > 0) {
    console.log("Run 'abmind embed' to enable semantic search on imported messages.");
  }
}

// ── CLI entry ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: abmind migrate-openclaw <dir-or-file> [options]

Import OpenClaw session transcripts (.jsonl) into abmind's memory.

Options:
  --chat-id <id>       Override chatId (single file only)
  --budget-chars <n>   Max chars per session (default ${DEFAULT_BUDGET_CHARS})
  --strict             Error on first malformed line
  --help               Show this help

Examples:
  abmind migrate-openclaw ~/.openclaw/sessions/
  abmind migrate-openclaw session.jsonl --chat-id my-chat`);
} else {
  migrateOpenclaw(args);
}
