/**
 * abmind standalone logger — file + stderr, level-gated.
 * No injection from hosts. abmind owns its logging.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type LogLevel = "off" | "low" | "debug" | "trace";

const LEVEL_ORDER: Record<LogLevel, number> = { off: 0, low: 1, debug: 2, trace: 3 };

let configuredLevel: LogLevel = ((): LogLevel => {
  const raw = process.env.ABMIND_LOG_LEVEL?.toLowerCase();
  if (raw && raw in LEVEL_ORDER) return raw as LogLevel;
  return "low";
})();

/** Override the level at runtime (tests, daemon control). Mirrors abtars. */
export function setLogLevel(level: LogLevel): void {
  configuredLevel = level;
}

/** Current level, for save/restore around level-sensitive tests. */
export function getLogLevel(): LogLevel {
  return configuredLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[configuredLevel] >= LEVEL_ORDER[level];
}

/** Mirrors abtars `isLogLevel`: guard expensive message construction. */
export function isLogLevel(minLevel: LogLevel): boolean {
  return LEVEL_ORDER[configuredLevel] >= LEVEL_ORDER[minLevel];
}

// ── Stderr policy ─────────────────────────────────────────────────────────
// "standard" (default): every emitted line also goes to stderr — hook, MCP,
// and CLI hosts surface it. "service": only WARN/ERROR go to stderr; the
// file still holds everything. The daemon/embedded bootstrap selects
// "service" (systemd journals duplicate every stderr line; launchd discards
// it), hook/MCP/CLI hosts keep the default.

export type StderrPolicy = "standard" | "service";

let stderrPolicy: StderrPolicy = "standard";

export function setStderrPolicy(policy: StderrPolicy): void {
  stderrPolicy = policy;
}

/** Current stderr policy, for save/restore in tests. */
export function getStderrPolicy(): StderrPolicy {
  return stderrPolicy;
}

// ── File logging ────────────────────────────────────────────────────────────

const logDir = process.env.ABMIND_LOG_FILE
  ? join(process.env.ABMIND_LOG_FILE, "..")
  : join(process.env.ABMIND_HOME ?? join(homedir(), ".abmind"), "logs");

let pruned = false;

function pruneOldLogs(): void {
  if (pruned) return;
  pruned = true;
  try {
    const { readdirSync, statSync, unlinkSync } = require("node:fs") as typeof import("node:fs");
    const cutoff = Date.now() - 5 * 86400000;
    for (const f of readdirSync(logDir)) {
      if (!f.startsWith("abmind-") || !f.endsWith(".log")) continue;
      const fp = join(logDir, f);
      try { if (statSync(fp).mtimeMs < cutoff) unlinkSync(fp); } catch {}
    }
  } catch {}
}

/** Today's log file; ABMIND_LOG_FILE overrides the dated name. */
function logFilePath(): string {
  const today = new Date().toISOString().slice(0, 10);
  return process.env.ABMIND_LOG_FILE ?? join(logDir, `abmind-${today}.log`);
}

function formatLine(level: string, tag: string, msg: string): string {
  return `${new Date().toISOString().slice(0, 23)} ${level.padEnd(5)} [${tag}] ${msg}\n`;
}

// ── Buffered file writer ──────────────────────────────────────────────
// One syscall per ~200 lines instead of per line. Flush is a synchronous
// append (like abtars), so the exit hook is guaranteed to land the tail;
// the flush timer is unref'd and the hook is registered lazily on first
// use to avoid import-time side effects.

let buffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let exitHookRegistered = false;

function flushBuffer(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (buffer.length === 0) return;
  const lines = buffer;
  buffer = [];
  try {
    pruneOldLogs();
    mkdirSync(logDir, { recursive: true });
    appendFileSync(logFilePath(), lines.join(""));
  } catch { /* logging must never fail the process */ }
}

/** Flush buffered lines. Called on process exit; tests may call directly. */
export function flushLogs(): void { flushBuffer(); }

function writeToFile(line: string): void {
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.on("exit", flushBuffer);
  }
  buffer.push(line);
  if (buffer.length >= 200) flushBuffer();
  else if (!flushTimer) {
    flushTimer = setTimeout(flushBuffer, 30000);
    flushTimer.unref();
  }
}

function emit(level: string, minLevel: LogLevel, tag: string, msg: string): void {
  if (!shouldLog(minLevel)) return;
  const line = formatLine(level, tag, msg);
  if (stderrPolicy === "standard" || level === "WARN" || level === "ERROR") {
    console.error(line.trimEnd());
  }
  writeToFile(line);
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
