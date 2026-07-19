#!/usr/bin/env node
/**
 * abmind doctor — health check CLI (#442, #780, #1452).
 * Local checks: permissions, standalone layout, key, templates, logs, encryptionUser.
 * Owner checks via operator.diagnose: DB, FTS, WAL, embeddings, sleep, backup.
 * Route owner repairs through operator.repair.
 * --quiet suppresses OK/SKIP lines.
 * --json outputs machine-readable JSON.
 */

import { existsSync, statSync, readdirSync, accessSync, constants, chmodSync, mkdirSync, readFileSync, lstatSync, readlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { DoctorCheckResult, DoctorRepairAction, DoctorRepairResult } from "../src/abmind-protocol.js";
import { standalonePaths } from "../src/deploy-lib/index.js";
import { readReleaseJson } from "./lib/standalone-installer.js";

const home = process.env.ABMIND_HOME ?? join(homedir(), ".abmind");
const argv = process.argv.slice(2);
const fix = argv.includes("--fix");
const quiet = argv.includes("--quiet");
const json = argv.includes("--json");

type Status = "ok" | "warn" | "error" | "skip";
interface CheckItem {
  name: string;
  status: Status;
  message: string;
  fixAction?: DoctorRepairAction;
}

const results: CheckItem[] = [];

function ok(name: string, message: string): CheckItem {
  return { name, status: "ok", message };
}

function warn(name: string, message: string, fixAction?: DoctorRepairAction): CheckItem {
  return { name, status: "warn", message, fixAction };
}

function errorItem(name: string, message: string): CheckItem {
  return { name, status: "error", message };
}

function skip(name: string, message: string): CheckItem {
  return { name, status: "skip", message };
}

function check(name: string, fn: () => CheckItem): void {
  try {
    const r = fn();
    results.push(r);
    if (!json) {
      if (quiet && (r.status === "ok" || r.status === "skip")) return;
      const icon = r.status === "ok" ? "[OK]  " : r.status === "warn" ? "[WARN]" : r.status === "skip" ? "[SKIP]" : "[ERR] ";
      process.stdout.write(`${icon} ${r.name}: ${r.message}\n`);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    results.push(errorItem(name, errMsg));
    if (!json) process.stdout.write(`[ERR]  ${name}: ${errMsg}\n`);
  }
}

function doFix(item: CheckItem): void {
  if (!fix || (item.status !== "warn" && item.status !== "error")) return;
  if (item.fixAction) {
    applyOwnerRepair(item.fixAction).then(() => {}).catch(() => {});
    return;
  }
  // Local fix via inline fn — handled by wrapping check() already
}

async function applyOwnerRepair(action: DoctorRepairAction): Promise<void> {
  try {
    const { AbmindClient } = await import("../src/abmind-client.js");
    const { LocalTransport } = await import("../src/local-transport.js");
    const envMod = await import("../src/env-schema.js");
    const transport = new LocalTransport(envMod.getAbmindEnv().localEndpoint);
    const client = new AbmindClient(transport);
    await client.negotiate();
    const result = await client.operator.repair(action);
    if (!json) process.stdout.write(`[FIX]  ${result.message}\n`);
    await client.close().catch(() => {});
  } catch (err) {
    if (!json) process.stdout.write(`[FIX]  repair failed: ${(err as Error).message}\n`);
  }
}

// ── Local filesystem checks (no daemon needed) ────────────────────────────

function checkDirMode(path: string, expected: number): CheckItem {
  if (!existsSync(path)) return warn(path, "missing");
  const mode = statSync(path).mode & 0o777;
  if (mode === expected) return ok(path, `${path} (${mode.toString(8)})`);
  return warn(path, `${mode.toString(8)} — should be ${expected.toString(8)}`);
}

function checkFilesMode(dir: string, expected: number): CheckItem {
  if (!existsSync(dir)) return skip(dir, "dir missing");
  const bad: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isFile() && (st.mode & 0o777) !== expected) bad.push(f);
  }
  if (bad.length === 0) return ok(`${dir}/*`, `all files ${expected.toString(8)}`);
  return warn(`${dir}/*`, `${bad.length} file(s) not ${expected.toString(8)}: ${bad.slice(0, 3).join(", ")}`);
}

(async () => {
  if (!json) {
    const { printBanner } = await import("./banner.js");
    await printBanner("doctor");
  }

  // Permissions — local
  check("root ~/.abmind/", () => checkDirMode(home, 0o700));
  check("config/ permissions", () => checkDirMode(join(home, "config"), 0o700));
  check("config/* files", () => checkFilesMode(join(home, "config"), 0o600));
  check("memory/ permissions", () => checkDirMode(join(home, "memory"), 0o700));
  check("secret/ permissions", () => checkDirMode(join(home, "secret"), 0o700));
  check("secret/* files", () => checkFilesMode(join(home, "secret"), 0o600));

  // Standalone layout — local
  check("standalone CLI layout", () => {
    const sp = standalonePaths(home);
    const issues: string[] = [];
    try {
      const st = lstatSync(sp.currentLink);
      if (!st.isSymbolicLink()) issues.push("current is not a symlink");
      else {
        const target = readlinkSync(sp.currentLink);
        const releaseDir = target.startsWith("/") ? target : join(sp.packagesStandalone, target);
        if (!existsSync(releaseDir)) issues.push(`current points to missing: ${target}`);
        else {
          const meta = readReleaseJson(releaseDir);
          if (!meta) issues.push(`release.json missing in: ${target}`);
          else if (!existsSync(join(releaseDir, meta.entrypoint))) issues.push(`entrypoint missing: ${meta.entrypoint}`);
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") issues.push("current symlink does not exist");
      else issues.push(`cannot stat: ${(err as Error).message}`);
    }
    try {
      const st = lstatSync(sp.publicBinLink);
      if (!st.isSymbolicLink()) issues.push("public bin not a symlink");
    } catch { issues.push("public bin link missing"); }
    if (issues.length === 0) return ok("standalone CLI layout", `active: ${sp.currentLink}`);
    return warn("standalone CLI layout", issues.join("; "));
  });

  // Key — local
  check("encryption key", () => {
    const keyFile = join(home, "secret", "abmind.key");
    const verifyFile = join(home, "secret", "key.verify");
    if (!existsSync(keyFile) && !existsSync(verifyFile)) return warn("encryption key", "no key file — secrets not encrypted");
    if (existsSync(keyFile) && !existsSync(verifyFile)) {
      // fix will be applied below; report as warn
      return warn("encryption key", "key file exists but key.verify missing");
    }
    return ok("encryption key", "key + verify present");
  });

  // Core templates — local
  check("core templates", () => {
    const coreDir = join(home, "memory", "core");
    if (!existsSync(coreDir)) return warn("core templates", "missing — run abmind install");
    const files = readdirSync(coreDir).filter(f => f.endsWith(".md"));
    return files.length >= 4
      ? ok("core templates", `${files.length} templates`)
      : warn("core templates", `only ${files.length} templates (expected >=4)`);
  });

  // Logs writable — local
  check("logs/ writable", () => {
    const logsDir = join(home, "logs");
    if (!existsSync(logsDir)) { mkdirSync(logsDir, { recursive: true, mode: 0o700 }); return ok("logs/ writable", "created"); }
    try { accessSync(logsDir, constants.W_OK); return ok("logs/ writable", "writable"); }
    catch { return warn("logs/ writable", "not writable"); }
  });

  // encryptionUser — local
  check("encryptionUser", () => {
    const manifestPath = join(home, "manifest.json");
    if (!existsSync(manifestPath)) return skip("encryptionUser", "no manifest");
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      if (!manifest.encryptionUser) return warn("encryptionUser", "missing — re-run abmind install or set in manifest.json");
      return ok("encryptionUser", manifest.encryptionUser);
    } catch { return skip("encryptionUser", "cannot read manifest"); }
  });

  // ── Owner-backed checks (via operator.diagnose) ────────────────────────
  // Negotiate one client, call operator.diagnose, merge results.
  try {
    const { AbmindClient } = await import("../src/abmind-client.js");
    const { LocalTransport } = await import("../src/local-transport.js");
    const { getAbmindEnv } = await import("../src/env-schema.js");
    const transport = new LocalTransport(getAbmindEnv().localEndpoint);
    const client = new AbmindClient(transport);
    await client.negotiate();

    const ownerChecks = await client.operator.diagnose();
    for (const oc of ownerChecks.checks) {
      results.push({ name: oc.name, status: oc.status as Status, message: oc.message, fixAction: oc.repair });
      if (!json) {
        if (quiet && (oc.status === "ok" || oc.status === "skip")) continue;
        const icon = oc.status === "ok" ? "[OK]  " : oc.status === "warn" ? "[WARN]" : oc.status === "skip" ? "[SKIP]" : "[ERR] ";
        process.stdout.write(`${icon} ${oc.name}: ${oc.message}\n`);
      }
      if (fix && oc.repair && (oc.status === "warn" || oc.status === "error")) {
        try {
          const r = await client.operator.repair(oc.repair);
          if (!json) process.stdout.write(`[FIX]  ${r.message}\n`);
        } catch (err) {
          if (!json) process.stdout.write(`[FIX]  repair failed: ${(err as Error).message}\n`);
        }
      }
    }
    await client.close().catch(() => {});
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (!json) process.stdout.write(`[WARN] daemon: ${msg}\n`);
    results.push(skip("daemon", `${msg}`));
  }

  // ── Summary ────────────────────────────────────────────────────────────
  const okCount = results.filter(r => r.status === "ok").length;
  const warnCount = results.filter(r => r.status === "warn").length;
  const errCount = results.filter(r => r.status === "error").length;

  if (json) {
    const normalize = (s: Status): string => s === "ok" ? "ok" : s === "skip" ? "skipped" : "failed";
    process.stdout.write(JSON.stringify({
      checks: results.map(r => ({ name: r.name, status: normalize(r.status), message: r.message })),
      summary: { ok: okCount, warn: warnCount, error: errCount },
    }) + "\n");
  } else {
    process.stdout.write(`\n${okCount} passed, ${warnCount} warnings, ${errCount} errors\n`);
  }

  process.exit(errCount > 0 ? 2 : warnCount > 0 ? 1 : 0);
})().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
