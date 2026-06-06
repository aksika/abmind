/**
 * status-block.ts — Build compact system status for session-start injection (#646).
 * One-liner when healthy, expands on problems. Skip for Code sessions.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MemoryManager } from "./memory-manager.js";
import { abmindHooksDir } from "./mem-paths.js";

export function buildStatusBlock(memory: MemoryManager): string {
  const db = memory.getDatabase();
  const memDir = memory.getConfig().memoryDir;
  const parts: string[] = [];
  const warnings: string[] = [];

  // Uptime (process)
  const uptimeH = Math.floor(process.uptime() / 3600);
  parts.push(`up ${uptimeH}h`);

  // Memory stats
  if (db) {
    const msgs = (db.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number })?.c ?? 0;
    const mems = (db.prepare("SELECT COUNT(*) as c FROM extracted_memories WHERE valid_to IS NULL").get() as { c: number })?.c ?? 0;
    parts.push(`${msgs} msgs, ${mems} memories`);
  }

  // Last sleep
  const sleepDir = join(memDir, "sleep");
  try {
    const files = readdirSync(sleepDir).filter(f => f.startsWith("sleep_") && f.endsWith(".lock")).sort();
    if (files.length > 0) {
      const latest = files[files.length - 1]!;
      const lock = JSON.parse(readFileSync(join(sleepDir, latest), "utf-8"));
      const st = statSync(join(sleepDir, latest));
      const hoursSince = (Date.now() - st.mtimeMs) / 3600_000;
      const time = new Date(st.mtimeMs).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false });

      if (lock.status === "ok" || lock.status === "completed") {
        if (hoursSince < 48) {
          parts.push(`sleep ok (${time})`);
        } else {
          warnings.push(`⚠️ Last sleep ${Math.round(hoursSince / 24)}d ago`);
        }
      } else {
        warnings.push(`⚠️ Last sleep FAILED (${time})`);
      }
    } else {
      warnings.push("⚠️ Never slept");
    }
  } catch { /* skip */ }

  // Task failures (today)
  try {
    const abtarsHome = process.env["ABTARS_HOME"] ?? join(require("os").homedir(), ".abtars");
    const tasksPath = join(abtarsHome, "tasks", "tasks.json");
    if (existsSync(tasksPath)) {
      const tasks = JSON.parse(readFileSync(tasksPath, "utf-8")) as Array<{ message: string; history?: Array<{ ts: number; exitCode?: number }> }>;
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const todayMs = todayStart.getTime();
      const failed = tasks.filter(t => t.history?.some(h => h.ts >= todayMs && h.exitCode && h.exitCode !== 0));
      if (failed.length > 0) {
        warnings.push(`⚠️ ${failed.length} task(s) failed today: ${failed.map(t => t.message).join(", ")}`);
      }
    }
  } catch { /* skip */ }

  // Errors
  const errLog = join(abmindHooksDir(), "errors.log");
  try {
    if (existsSync(errLog)) {
      const content = readFileSync(errLog, "utf-8").trim();
      if (content) {
        const lines = content.split("\n");
        const recent = lines.slice(-3).map(l => l.slice(0, 50)).join("; ");
        warnings.push(`⚠️ Errors (${Math.min(lines.length, 3)}): ${recent}`);
      }
    }
  } catch { /* skip */ }

  let result = `[SYSTEM STATUS] ${parts.join(" | ")}`;
  if (warnings.length > 0) result += "\n" + warnings.join("\n");
  return result;
}
