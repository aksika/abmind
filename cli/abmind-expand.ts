#!/usr/bin/env node
/**
 * abmind-expand — look up original messages by ID.
 *
 * Read-only: opens its own DB handle so it's safe against a live bridge
 * (WAL concurrent read). No MemoryBackend needed → runCliRaw.
 *
 * Note (post #207): `abmind expand` now works via the unified dispatcher
 * too. Previously the hand-rolled isDirectRun only matched .ts/.js
 * filenames, not the dispatcher bin path — see #202 for the same bug
 * class fixed in store/edit/retro-extract.
 */
import { requireNativeDep } from "./lib/native-dep.js";
const Database = requireNativeDep("better-sqlite3");
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCliRaw } from "../src/cli-runner-raw.js";
import type { FlagSpec } from "../src/cli-flags.js";
import { localISO } from "../src/local-time.js";
import { abmindHome } from "../src/mem-paths.js";
import { SleepDataAccess } from "../src/sleep-data-access.js";
import { redactSecrets } from "../src/redact-secrets.js";
import { CONSUMED_SESSION_SQL, scopeOfSession } from "../src/sleep/coverage.js";

const FLAGS: readonly FlagSpec[] = [
  { name: "ids", type: "string" },
  { name: "since-last-extraction", type: "boolean" },
  { name: "format", type: "string" },
];

/** Legacy export kept for cli/abmind-expand.test.ts compatibility (orphan — moves to src/ separately). */
export function parseArgs(argv = process.argv): { ids: number[] } {
  const args = argv.slice(2);
  let ids: number[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ids") {
      ids = (args[++i] ?? "").split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
    }
  }
  return { ids };
}

await runCliRaw(import.meta.url, {
  name: "abmind-expand",
  help: `Usage:
  abmind expand --ids <id1,id2,...>

Prints the original messages for a list of message IDs as JSON.
Typically fed from the 'source_ids' field on a recall result.`,
  flags: FLAGS,
  handler: () => {
    const raw = process.argv.slice(2);
    const sinceLastExtraction = raw.includes("--since-last-extraction");
    const formatIndex = raw.indexOf("--format");
    const format = formatIndex === -1 ? undefined : raw[formatIndex + 1];

    const dbPath = join(abmindHome(), "memory", "memory.db");
    if (!existsSync(dbPath)) {
      console.error(`Memory database not found: ${dbPath}`);
      process.exitCode = 1; return;
    }

    // #366 — since-last-extraction mode (for hook-triggered extraction)
    if (sinceLastExtraction) {
      const db = new Database(dbPath, { readonly: true });
      try {
        const sleepData = new SleepDataAccess(db);
        const userId = sleepData.getPrimaryUserId();
        const watermark = sleepData.getExtractionWatermark(userId);
        if (format === "coverage-json") {
          const rows = db.prepare(
            `SELECT id, session_id, role, content, timestamp FROM messages
             WHERE user_id = ? AND timestamp > ? AND ${CONSUMED_SESSION_SQL}
               AND content NOT LIKE '[SYSTEM%'
             ORDER BY timestamp ASC, id ASC LIMIT 30`,
          ).all(userId, watermark) as Array<{ id: number; session_id: string | null; role: string; content: string; timestamp: number }>;
          // Include the full cutoff timestamp group. A scalar timestamp watermark
          // cannot distinguish messages sharing one millisecond, so advancing
          // past only some rows at that timestamp would lose the rest.
          if (rows.length === 30) {
            const last = rows.at(-1);
            if (last) {
              const tied = db.prepare(
                `SELECT id, session_id, role, content, timestamp FROM messages
                 WHERE user_id = ? AND timestamp = ? AND id > ? AND ${CONSUMED_SESSION_SQL}
                   AND content NOT LIKE '[SYSTEM%'
                 ORDER BY id ASC`,
              ).all(userId, last.timestamp, last.id) as Array<{ id: number; session_id: string | null; role: string; content: string; timestamp: number }>;
              rows.push(...tied);
            }
          }
          const messages = rows.map(r => ({
            id: r.id,
            session_id: r.session_id,
            role: r.role,
            content: redactSecrets(r.content),
            timestamp: r.timestamp,
          }));
          const last = rows.at(-1);
          console.log(JSON.stringify({
            messages,
            coverage: last ? {
              throughTs: last.timestamp,
              messageCount: rows.length,
              scopes: [...new Set(rows.map(row => scopeOfSession(row.session_id)))],
            } : null,
          }, null, 2));
          return;
        }

        // Keep the original array shape for existing JSON consumers.
        const rows = db.prepare(
          "SELECT id, role, content, timestamp FROM messages WHERE user_id = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT 30",
        ).all(userId, watermark) as Array<{ id: number; role: string; content: string; timestamp: number }>;
        const output = rows.map(r => ({
          id: r.id, role: r.role,
          content: redactSecrets(r.content).slice(0, 500),
          timestamp: r.timestamp,
        }));
        console.log(JSON.stringify(output, null, 2));
      } finally { db.close(); }
      return;
    }

    // Parse ids from raw argv (supports both --ids "1,2,3" and legacy positional)
    const { ids } = parseArgs(process.argv);
    if (ids.length === 0) {
      console.error("Usage: abmind expand --ids <id1,id2,...>");
      process.exitCode = 1; return;
    }
    void raw;

    const db = new Database(dbPath, { readonly: true });
    try {
      const placeholders = ids.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT id, role, content, timestamp, user_id FROM messages WHERE id IN (${placeholders}) ORDER BY timestamp ASC`,
      ).all(...ids) as Array<{ id: number; role: string; content: string; timestamp: number; user_id: string }>;

      const results = rows.map(r => ({
        id: r.id,
        role: r.role,
        content: r.content,
        date: localISO(new Date(r.timestamp)),
        user_id: r.user_id,
      }));
      console.log(JSON.stringify(results, null, 2));
    } finally {
      db.close();
    }
  },
});
