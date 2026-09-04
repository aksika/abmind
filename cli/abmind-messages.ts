#!/usr/bin/env node
/**
 * abmind-messages — read back raw conversation messages from the messages table.
 *
 * Read-only: opens its own DB handle (WAL concurrent read) so it's safe against
 * a live bridge/gateway. No MemoryBackend needed → runCliRaw.
 *
 * Modes:
 *   - no --session: list sessions (session_id, message count, last activity)
 *   - --session <id>: dump the last --tail messages, newest first, redacted
 */

import { requireNativeDep } from "./lib/native-dep.js";
const Database = requireNativeDep("better-sqlite3");
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCliRaw } from "../src/cli-runner-raw.js";
import type { FlagSpec } from "../src/cli-flags.js";
import { localDateTime } from "../src/local-time.js";
import { abmindHome } from "../src/mem-paths.js";
import { redactSecrets } from "../src/redact-secrets.js";

const FLAGS: readonly FlagSpec[] = [
  { name: "session", type: "string" },
  { name: "tail", type: "number" },
  { name: "json", type: "boolean" },
  { name: "raw", type: "boolean" },
];

const CONTENT_TRUNCATE = 500;

interface MessageRow {
  id: number;
  user_id: string;
  session_id: string;
  role: string;
  content: string;
  timestamp: number;
}

interface SessionRow {
  session_id: string;
  msgs: number;
  last: number;
}

await runCliRaw(import.meta.url, {
  name: "abmind-messages",
  help: `Usage:
  abmind messages                       List sessions (id, count, last activity)
  abmind messages --session <id>        Dump last messages of a session (newest first)
  abmind messages --session <id> --tail 100
  abmind messages --session <id> --json   Machine-readable JSON output
  abmind messages --raw                 Skip secret redaction (default: redacted)

Read-only — never writes to the memory database.`,
  flags: FLAGS,
  handler: () => {
    const raw = process.argv.slice(2);
    const session = raw.includes("--session") ? raw[raw.indexOf("--session") + 1] : undefined;
    const tailIdx = raw.indexOf("--tail");
    const tail = tailIdx >= 0 ? Number(raw[tailIdx + 1]) : 30;
    const asJson = raw.includes("--json");
    const rawContent = raw.includes("--raw");

    const dbPath = join(abmindHome(), "memory", "memory.db");
    if (!existsSync(dbPath)) {
      console.error(`Memory database not found: ${dbPath}`);
      process.exitCode = 1; return;
    }

    const db = new Database(dbPath, { readonly: true });
    try {
      if (!session) {
        const rows = db.prepare(
          "SELECT session_id, COUNT(*) AS msgs, MAX(timestamp) AS last FROM messages GROUP BY session_id ORDER BY last DESC",
        ).all() as SessionRow[];
        if (asJson) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        if (rows.length === 0) {
          console.log("No messages in the messages table.");
          return;
        }
        for (const r of rows) {
          const last = r.last ? localDateTime(new Date(r.last)) : "-";
          console.log(`${r.session_id}\t${r.msgs} msgs\tlast ${last}`);
        }
        return;
      }

      const n = Number.isFinite(tail) && tail > 0 ? Math.floor(tail) : 30;
      const rows = db.prepare(
        `SELECT id, user_id, session_id, role, content, timestamp FROM messages
         WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
      ).all(session, n) as MessageRow[];

      if (asJson) {
        const output = rows.map(r => ({
          id: r.id,
          role: r.role,
          content: rawContent ? r.content : redactSecrets(r.content).slice(0, CONTENT_TRUNCATE),
          timestamp: r.timestamp,
          time: localDateTime(new Date(r.timestamp)),
        }));
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      if (rows.length === 0) {
        console.log(`No messages for session ${session}`);
        return;
      }
      for (const r of rows) {
        const content = rawContent ? r.content : redactSecrets(r.content).slice(0, CONTENT_TRUNCATE);
        const time = localDateTime(new Date(r.timestamp));
        console.log(`#${r.id} [${time} ${r.role}] ${content}`);
      }
    } finally {
      db.close();
    }
  },
});