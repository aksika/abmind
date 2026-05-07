#!/usr/bin/env node
/**
 * abmind doctor — health check CLI (#442).
 * Checks permissions, DB, ollama, templates, sqlite-vec.
 * --fix auto-corrects what it can.
 */

import { existsSync, statSync, readdirSync, accessSync, constants, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const home = process.env.ABMIND_HOME ?? join(homedir(), ".abmind");
const fix = process.argv.includes("--fix");

type Status = "ok" | "warn" | "error" | "skip";
type CheckResult = { status: Status; message: string; fix?: () => void };

const results: CheckResult[] = [];

function check(name: string, fn: () => CheckResult): void {
  try {
    const r = fn();
    results.push(r);
    const icon = r.status === "ok" ? "[OK]  " : r.status === "warn" ? "[WARN]" : r.status === "skip" ? "[SKIP]" : "[ERR] ";
    process.stdout.write(`${icon} ${name}: ${r.message}\n`);
    if (fix && r.fix && r.status === "warn") {
      r.fix();
      process.stdout.write(`[FIX]  ${name} → corrected\n`);
    }
  } catch (err) {
    results.push({ status: "error", message: String(err) });
    process.stdout.write(`[ERR]  ${name}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

function checkDirMode(path: string, expected: number): CheckResult {
  if (!existsSync(path)) return { status: "warn", message: "missing" };
  const mode = statSync(path).mode & 0o777;
  if (mode === expected) return { status: "ok", message: `${path} (${mode.toString(8)})` };
  return { status: "warn", message: `${mode.toString(8)} — should be ${expected.toString(8)}`, fix: () => chmodSync(path, expected) };
}

function checkFilesMode(dir: string, expected: number): CheckResult {
  if (!existsSync(dir)) return { status: "skip", message: "dir missing" };
  const bad: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isFile() && (st.mode & 0o777) !== expected) bad.push(f);
  }
  if (bad.length === 0) return { status: "ok", message: `all files ${expected.toString(8)}` };
  return {
    status: "warn",
    message: `${bad.length} file(s) not ${expected.toString(8)}: ${bad.slice(0, 3).join(", ")}`,
    fix: () => { for (const f of bad) chmodSync(join(dir, f), expected); },
  };
}

// ── Checks ──────────────────────────────────────────────────────────────────

process.stdout.write(`abmind doctor\n${"=".repeat(40)}\n`);

check("root ~/.abmind/", () => checkDirMode(home, 0o700));
check("config/ permissions", () => checkDirMode(join(home, "config"), 0o700));
check("config/* files", () => checkFilesMode(join(home, "config"), 0o600));
check("memory/ permissions", () => checkDirMode(join(home, "memory"), 0o700));

check("memory.db exists", () => {
  const p = join(home, "memory", "memory.db");
  return existsSync(p) ? { status: "ok", message: p } : { status: "warn", message: "missing — run abmind to initialize" };
});

check("core templates", () => {
  const coreDir = join(home, "memory", "core");
  if (!existsSync(coreDir)) return { status: "warn", message: "missing — run abmind install" };
  const files = readdirSync(coreDir).filter(f => f.endsWith(".md"));
  return files.length >= 4
    ? { status: "ok", message: `${files.length} templates` }
    : { status: "warn", message: `only ${files.length} templates (expected ≥4)` };
});

check("logs/ writable", () => {
  const logsDir = join(home, "logs");
  if (!existsSync(logsDir)) return { status: "warn", message: "missing", fix: () => { require("fs").mkdirSync(logsDir, { recursive: true, mode: 0o700 }); } };
  try { accessSync(logsDir, constants.W_OK); return { status: "ok", message: "writable" }; }
  catch { return { status: "warn", message: "not writable" }; }
});

check("ollama reachable", () => {
  try {
    const { execSync } = require("child_process");
    execSync("curl -sf http://localhost:11434/api/tags", { timeout: 3000, stdio: "pipe" });
    return { status: "ok", message: "localhost:11434" };
  } catch { return { status: "warn", message: "ollama not running or not reachable" }; }
});

check("embedding model", () => {
  try {
    const { execSync } = require("child_process");
    const out = execSync("curl -sf http://localhost:11434/api/tags", { timeout: 3000, encoding: "utf-8" });
    const models = JSON.parse(out).models?.map((m: any) => m.name) ?? [];
    const has = models.some((n: string) => n.includes("nomic-embed-text"));
    return has ? { status: "ok", message: "nomic-embed-text" } : { status: "warn", message: `not found (available: ${models.slice(0, 3).join(", ")})` };
  } catch { return { status: "skip", message: "ollama not reachable" }; }
});

check("sqlite-vec", () => {
  try {
    require.resolve("sqlite-vec");
    return { status: "ok", message: "loadable" };
  } catch { return { status: "warn", message: "not installed (brute-force fallback)" }; }
});

check("IPC socket", () => {
  const sock = join(home, "memory.sock");
  if (!existsSync(sock)) return { status: "skip", message: "not running (bridge offline)" };
  return { status: "ok", message: sock };
});

// ── Summary ─────────────────────────────────────────────────────────────────

const ok = results.filter(r => r.status === "ok").length;
const warn = results.filter(r => r.status === "warn").length;
const err = results.filter(r => r.status === "error").length;
process.stdout.write(`\n${ok} passed, ${warn} warnings, ${err} errors\n`);
process.exit(err > 0 ? 1 : 0);
