#!/usr/bin/env node
/**
 * abmind-personal — Owner controls for the three-layer personal lifecycle (#1930).
 *
 * Supported owner API/CLI surface: inspect origin/evidence/recall reason,
 * explain, correct/scope via durable supersession, forget with derived
 * coverage, reviewed conversion inspect/apply, readiness status, and
 * profiled recall (fast/normal/full with the frozen S6 boundary).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runCliRaw } from "../src/cli-runner-raw.js";
import type { FlagSpec } from "../src/cli-flags.js";
import { abmindHome } from "../src/mem-paths.js";
import { loadMemoryConfig } from "../src/memory-config.js";
import { initializeDatabase, registerFunctions } from "../src/memory-db.js";
import { ensureInitialized } from "../src/ensure-initialized.js";
import { requireNativeDep } from "./lib/native-dep.js";

const FLAGS: readonly FlagSpec[] = [
  { name: "action", type: "string" },
  { name: "user-id", type: "string" },
  { name: "layer", type: "string" },
  { name: "id", type: "number" },
  { name: "profile", type: "string" },
  { name: "query", type: "string" },
  { name: "scope", type: "string" },
  { name: "as-of", type: "string" },
  { name: "durable-id", type: "number" },
  { name: "episode-id", type: "number" },
  { name: "message-ids", type: "string" },
  { name: "decisions", type: "string" },
  { name: "backup", type: "string" },
  { name: "limit", type: "number" },
];

function openDb(): { db: import("better-sqlite3").Database; memoryDir: string } {
  const Database = requireNativeDep("better-sqlite3") as typeof import("better-sqlite3");
  const config = loadMemoryConfig();
  const dbPath = join(config.memoryDir, "memory.db");
  if (!existsSync(dbPath)) {
    console.log(JSON.stringify({ ok: false, error: `memory database not found: ${dbPath}` }));
    process.exit(1);
    throw new Error("no db");
  }
  const db = initializeDatabase(dbPath);
  ensureInitialized(db, config.memoryDir);
  void Database;
  void registerFunctions;
  return { db, memoryDir: config.memoryDir };
}

function ownerOf(args: Record<string, unknown>): string {
  const owner = (args["user-id"] as string | undefined) ?? process.env["ABMIND_USER_ID"];
  if (!owner) {
    console.log(JSON.stringify({ ok: false, error: "owner required: pass --user-id or set ABMIND_USER_ID" }));
    process.exit(1);
    throw new Error("no owner");
  }
  return owner;
}

await runCliRaw(import.meta.url, {
  name: "abmind-personal",
  help: `Usage:
  abmind personal --action status [--user-id <owner>]
  abmind personal --action inspect --layer durable|episode|raw --id <id> [--user-id <owner>]
  abmind personal --action explain --profile recall_fast|recall_normal|recall_full --query "<q>" --layer durable|episode --id <id>
  abmind personal --action recall --profile recall_fast|recall_normal|recall_full --query "<q>" [--limit N]
  abmind personal --action belief --scope '{"scope":"general"}' [--as-of YYYY-MM-DD]
  abmind personal --action forget --durable-id <id> | --episode-id <id> | --message-ids <a,b> [--user-id <owner>]
  abmind personal --action convert-inspect
  abmind personal --action convert-apply --decisions <0600-json> --backup <verified-backup>`,
  flags: FLAGS,
  handler: async ({ args }) => {
    const action = String(args["action"] ?? "");
    const [{ db, memoryDir }] = [openDb()];
    try {
      const { personalStatus } = await import("../src/personal-readiness.js");
      const { inspectPersonal, explainPersonal } = await import("../src/personal-controls.js");
      const { personalRecall } = await import("../src/personal-recall.js");
      const { resolveCurrentBelief, resolveBeliefAsOf } = await import("../src/personal-beliefs.js");
      const { inspectPersonalConversion, applyPersonalConversion } = await import("../src/personal-conversion.js");
      const { verifyBackupFile } = await import("../src/backup.js");

      if (action === "status") {
        console.log(JSON.stringify({ ok: true, status: personalStatus(db) }));
        return;
      }
      const owner = ownerOf(args as Record<string, unknown>);
      if (action === "inspect") {
        const layer = String(args["layer"] ?? "") as "durable" | "episode" | "raw";
        const id = Number(args["id"]);
        if (!["durable", "episode", "raw"].includes(layer) || !Number.isSafeInteger(id)) {
          console.log(JSON.stringify({ ok: false, error: "--layer durable|episode|raw and --id required" }));
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify({ ok: true, result: inspectPersonal(db, owner, { layer, id }) }));
        return;
      }
      if (action === "explain") {
        const profile = String(args["profile"] ?? "") as "recall_fast" | "recall_normal" | "recall_full";
        const query = String(args["query"] ?? "");
        const layer = String(args["layer"] ?? "") as "durable" | "episode";
        const id = Number(args["id"]);
        if (!query || !["recall_fast", "recall_normal", "recall_full"].includes(profile)) {
          console.log(JSON.stringify({ ok: false, error: "--profile and --query required" }));
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify({ ok: true, result: explainPersonal(db, owner, { profile, query, memoryLayer: layer, memoryId: id }) }));
        return;
      }
      if (action === "recall") {
        const profile = String(args["profile"] ?? "") as "recall_fast" | "recall_normal" | "recall_full";
        const query = String(args["query"] ?? "");
        if (!query || !["recall_fast", "recall_normal", "recall_full"].includes(profile)) {
          console.log(JSON.stringify({ ok: false, error: "--profile and --query required" }));
          process.exitCode = 1;
          return;
        }
        const limit = args["limit"] !== undefined ? Number(args["limit"]) : 10;
        console.log(JSON.stringify({ ok: true, result: personalRecall(db, owner, profile, query, { limit }) }));
        return;
      }
      if (action === "belief") {
        const scopeRaw = String(args["scope"] ?? '{"scope":"general"}');
        let scope: Record<string, unknown>;
        try {
          scope = JSON.parse(scopeRaw) as Record<string, unknown>;
        } catch {
          console.log(JSON.stringify({ ok: false, error: "--scope must be JSON" }));
          process.exitCode = 1;
          return;
        }
        const asOf = args["as-of"] !== undefined ? String(args["as-of"]) : undefined;
        const result = asOf
          ? resolveBeliefAsOf(db, owner, scope, asOf)
          : resolveCurrentBelief(db, owner, scope);
        console.log(JSON.stringify({ ok: true, result }));
        return;
      }
      if (action === "forget") {
        const { PrivateMemoryMutationStore } = await import("../src/private-memory-mutation-store.js");
        const store = new PrivateMemoryMutationStore(db);
        const targets: Array<{ kind: "durable"; id: number } | { kind: "episode"; id: number } | { kind: "raw"; messageIds: number[] }> = [];
        if (args["durable-id"] !== undefined) targets.push({ kind: "durable", id: Number(args["durable-id"]) });
        if (args["episode-id"] !== undefined) targets.push({ kind: "episode", id: Number(args["episode-id"]) });
        if (args["message-ids"] !== undefined) {
          const ids = String(args["message-ids"]).split(",").map((s) => Number(s.trim())).filter((n) => Number.isSafeInteger(n) && n > 0);
          if (ids.length > 0) targets.push({ kind: "raw", messageIds: ids });
        }
        if (targets.length === 0) {
          console.log(JSON.stringify({ ok: false, error: "--durable-id, --episode-id or --message-ids required" }));
          process.exitCode = 1;
          return;
        }
        const result = store.forgetPersonal({ owner, targets: targets as never, memoryDir, actorId: `cli:personal:${owner}` });
        console.log(JSON.stringify({ ok: true, result }));
        return;
      }
      if (action === "convert-inspect") {
        console.log(JSON.stringify({ ok: true, plan: inspectPersonalConversion(db) }));
        return;
      }
      if (action === "convert-apply") {
        const decisionsPath = args["decisions"] !== undefined ? String(args["decisions"]) : undefined;
        const backupPath = args["backup"] !== undefined ? String(args["backup"]) : undefined;
        if (!decisionsPath || !backupPath) {
          console.log(JSON.stringify({ ok: false, error: "--decisions <0600-json> and --backup <verified-backup> required" }));
          process.exitCode = 1;
          return;
        }
        if (!verifyBackupFile(backupPath)) {
          console.log(JSON.stringify({ ok: false, error: "backup verification failed — create and verify one first" }));
          process.exitCode = 1;
          return;
        }
        const decisions = JSON.parse(readFileSync(decisionsPath, "utf-8")) as never;
        console.log(JSON.stringify({ ok: true, result: applyPersonalConversion(db, decisions as never, { verifiedBackupPath: backupPath }) }));
        return;
      }
      console.log(JSON.stringify({ ok: false, error: `unknown --action: ${action}` }));
      process.exitCode = 1;
    } finally {
      try {
        db.close();
      } catch { /* ignore */ }
      void memoryDir;
      void abmindHome;
    }
  },
});
