/**
 * abmind standalone logger — file + stderr, level-gated.
 * No injection from hosts. abmind owns its logging.
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type LogLevel = "off" | "low" | "debug" | "trace";

const LEVEL_ORDER: Record<LogLevel, number> = { off: 0, low: 1, debug: 2, trace: 3 };

const configuredLevel: LogLevel = ((): LogLevel => {
  const raw = process.env.ABMIND_LOG_LEVEL?.toLowerCase();
  if (raw && raw in LEVEL_ORDER) return raw as LogLevel;
  return "low";
})();

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[configuredLevel] >= LEVEL_ORDER[level];
}

// ── File logging ────────────────────────────────────────────────────────────

const logDir = process.env.ABMIND_LOG_FILE
  ? join(process.env.ABMIND_LOG_FILE, "..")
  : join(process.env.ABMIND_HOME ?? join(homedir(), ".abmind"), "logs");

let currentDate = "";
let stream: WriteStream | null = null;
let pruned = false;

function pruneOldLogs(): void {
  if (pruned) return;
  pruned = true;
  try {
    const { readdirSync, statSync, unlinkSync } = require("node:fs") as typeof import("node:fs");
    const cutoff = Date.now() - 3 * 86400000;
    for (const f of readdirSync(logDir)) {
      if (!f.startsWith("abmind-") || !f.endsWith(".log")) continue;
      const fp = join(logDir, f);
      try { if (statSync(fp).mtimeMs < cutoff) unlinkSync(fp); } catch {}
    }
  } catch {}
}

function getStream(): WriteStream | null {
  if (configuredLevel === "off") return null;
  const today = new Date().toISOString().slice(0, 10);
  if (today !== currentDate || !stream) {
    if (stream) stream.end();
    try { mkdirSync(logDir, { recursive: true }); } catch {}
    pruneOldLogs();
    const filePath = process.env.ABMIND_LOG_FILE ?? join(logDir, `abmind-${today}.log`);
    stream = createWriteStream(filePath, { flags: "a" });
    stream.on("error", () => {}); // swallow write errors
    currentDate = today;
  }
  return stream;
}

function formatLine(level: string, tag: string, msg: string): string {
  return `${new Date().toISOString().slice(0, 23)} ${level.padEnd(5)} [${tag}] ${msg}\n`;
}

function emit(level: string, minLevel: LogLevel, tag: string, msg: string): void {
  if (!shouldLog(minLevel)) return;
  const line = formatLine(level, tag, msg);
  console.error(line.trimEnd());
  getStream()?.write(line);
}

// ── Public API ──────────────────────────────────────────────────────────────

export function logInfo(tag: string, msg: string): void { emit("INFO", "low", tag, msg); }
export function logWarn(tag: string, msg: string): void { emit("WARN", "low", tag, msg); }
export function logError(tag: string, msg: string, err?: unknown): void {
  const suffix = err ? ` ${err instanceof Error ? err.message : String(err)}` : "";
  emit("ERROR", "low", tag, msg + suffix);
}
export function logDebug(tag: string, msg: string): void { emit("DEBUG", "debug", tag, msg); }
export function logTrace(tag: string, msg: string): void { emit("TRACE", "trace", tag, msg); }
