#!/usr/bin/env node
/**
 * abmind hook doctor — diagnostic for the #344 hook subcommands.
 *
 * Shows: recent error log, active sidecar files, current env config.
 */

import { runCliRaw } from "../src/cli-runner-raw.js";
import { abmindHooksDir, hookErrorLogPath, hookSidecarKey } from "../src/mem-paths.js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function tail(text: string, n: number): string {
  const lines = text.trimEnd().split("\n");
  return lines.slice(-n).join("\n");
}

await runCliRaw(import.meta.url, {
  name: "abmind-hook-doctor",
  help: `Usage:
  abmind hook doctor

Diagnostic output for abmind's Kiro hook subcommands (#344).
Shows recent errors, active sidecar files, and environment config.`,
  flags: [],
  handler: () => {
    const dir = abmindHooksDir();
    const errLog = hookErrorLogPath();

    console.log("abmind hook doctor");
    console.log("==================");
    console.log(`hooks dir:  ${dir}`);
    console.log(`sidecar key: ${hookSidecarKey()}`);
    console.log("");

    console.log("Environment:");
    console.log(`  ABMIND_HOOKS_DISABLED      = ${process.env.ABMIND_HOOKS_DISABLED ?? "(unset, default: false)"}`);
    console.log(`  ABMIND_HOOK_RECALL_LIMIT   = ${process.env.ABMIND_HOOK_RECALL_LIMIT ?? "(unset, default: 5)"}`);
    console.log(`  ABMIND_HOOK_RECALL_MAX_CHARS = ${process.env.ABMIND_HOOK_RECALL_MAX_CHARS ?? "(unset, default: 2000)"}`);
    console.log(`  ABMIND_HOOK_WAKEUP_MAX_CHARS = ${process.env.ABMIND_HOOK_WAKEUP_MAX_CHARS ?? "(unset, default: 5000)"}`);
    console.log(`  KIRO_SESSION_ID            = ${process.env.KIRO_SESSION_ID ?? "(unset — using fallback key)"}`);
    console.log("");

    console.log("Active sidecar files:");
    try {
      const files = readdirSync(dir).filter(f => f.startsWith("last-prompt-"));
      if (files.length === 0) {
        console.log("  (none)");
      } else {
        for (const f of files) {
          const p = join(dir, f);
          const st = statSync(p);
          const ageMin = Math.round((Date.now() - st.mtimeMs) / 60000);
          console.log(`  ${f}  (${st.size} bytes, ${ageMin} min old)`);
        }
      }
    } catch {
      console.log("  (hooks dir does not exist — no hooks have run yet)");
    }
    console.log("");

    console.log("Recent errors (last 50 lines of errors.log):");
    if (existsSync(errLog)) {
      const content = readFileSync(errLog, "utf-8");
      const last = tail(content, 50);
      if (last.trim()) {
        console.log(last);
      } else {
        console.log("  (empty)");
      }
    } else {
      console.log("  (no error log yet — zero errors since hooks dir created)");
    }
  },
});
