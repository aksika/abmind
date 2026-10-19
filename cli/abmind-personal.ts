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
  { name: "expected-revision", type: "number" },
  { name: "content", type: "string" },
  { name: "authority", type: "string" },
  { name: "authority-basis", type: "string" },
  { name: "evidence-message-ids", type: "string" },
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
  abmind personal --action correct --durable-id <id> --expected-revision <n> [--content "<text>"] [--authority <class>] [--authority-basis "<why>"] [--scope '{...}'] --evidence-message-ids <a,b>
  abmind personal --action scope --durable-id <id> --expected-revision <n> --scope '{"scope":"work"}' --evidence-message-ids <a,b> [--content "<text>"]
  abmind personal --action forget --durable-id <id> | --episode-id <id> | --message-ids <a,b> [--user-id <owner>]
  abmind personal --action convert-inspect
  abmind personal --action convert-apply --decisions <0600-json> --backup <verified-backup>
  abmind personal --action projection-inspect [--user-id <owner>]
  abmind personal --action projection-build --backup <verified-backup> [--user-id <owner>]
  abmind personal --action projection-vectors [--user-id <owner>]
  abmind personal --action reown-inspect --user-id <owner>
  abmind personal --action reown-apply --decisions <0600-json> --backup <verified-backup> --user-id <owner>`,
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
      if (action === "correct" || action === "scope") {
        // Owner correction / applicability restriction through the same
        // revision-safe mutation boundary. Evidence is built from real owner
        // source quotes (never model text); the writer refuses user authority
        // without user evidence and agent proposals as confirmed decisions.
        const { PrivateMemoryMutationStore } = await import("../src/private-memory-mutation-store.js");
        const { getDurable } = await import("../src/personal-durable.js");
        const store = new PrivateMemoryMutationStore(db);
        const memoryId = args["durable-id"] !== undefined ? Number(args["durable-id"]) : NaN;
        const expectedRevision = args["expected-revision"] !== undefined ? Number(args["expected-revision"]) : NaN;
        if (!Number.isSafeInteger(memoryId) || !Number.isSafeInteger(expectedRevision)) {
          console.log(JSON.stringify({ ok: false, error: "--durable-id and --expected-revision required" }));
          process.exitCode = 1;
          return;
        }
        const current = getDurable(db, owner, memoryId);
        if (!current) {
          console.log(JSON.stringify({ ok: false, error: "durable memory not found or not owned by caller" }));
          process.exitCode = 1;
          return;
        }
        const content = args["content"] !== undefined ? String(args["content"]) : current.content;
        if (!content.trim()) {
          console.log(JSON.stringify({ ok: false, error: "--content required (or already stored)" }));
          process.exitCode = 1;
          return;
        }
        const authority = (args["authority"] !== undefined ? String(args["authority"]) : current.authority) as
          "user_statement" | "confirmed_decision" | "agent_proposal" | "inference";
        if (!["user_statement", "confirmed_decision", "agent_proposal", "inference"].includes(authority)) {
          console.log(JSON.stringify({ ok: false, error: "--authority must be user_statement|confirmed_decision|agent_proposal|inference" }));
          process.exitCode = 1;
          return;
        }
        const authorityBasis = args["authority-basis"] !== undefined ? String(args["authority-basis"]) : "owner correction via CLI";
        let applicabilityScope: Record<string, unknown> | undefined;
        if (action === "scope") {
          if (args["scope"] === undefined) {
            console.log(JSON.stringify({ ok: false, error: "--scope JSON required for scope restriction" }));
            process.exitCode = 1;
            return;
          }
          try {
            applicabilityScope = JSON.parse(String(args["scope"])) as Record<string, unknown>;
          } catch {
            console.log(JSON.stringify({ ok: false, error: "--scope must be JSON" }));
            process.exitCode = 1;
            return;
          }
        } else if (args["scope"] !== undefined) {
          try {
            applicabilityScope = JSON.parse(String(args["scope"])) as Record<string, unknown>;
          } catch {
            console.log(JSON.stringify({ ok: false, error: "--scope must be JSON" }));
            process.exitCode = 1;
            return;
          }
        }
        const evidenceIds = args["evidence-message-ids"] !== undefined
          ? String(args["evidence-message-ids"]).split(",").map((s) => Number(s.trim())).filter((n) => Number.isSafeInteger(n) && n > 0)
          : [];
        if (evidenceIds.length === 0) {
          console.log(JSON.stringify({ ok: false, error: "--evidence-message-ids (owner source messages) required" }));
          process.exitCode = 1;
          return;
        }
        const evidence: Array<{ kind: string; ref: string; excerpt: string; classification: number }> = [];
        for (const mid of evidenceIds) {
          const msg = db.prepare("SELECT role, content FROM messages WHERE id = ? AND user_id = ?").get(mid, owner) as
            | { role: string; content: string } | undefined;
          if (!msg) {
            console.log(JSON.stringify({ ok: false, error: `evidence message ${mid} not found or not owned by caller` }));
            process.exitCode = 1;
            return;
          }
          evidence.push({
            kind: msg.role === "user" ? "user_message" : "agent_message",
            ref: `messages:${mid}`,
            excerpt: msg.content.slice(0, 500),
            classification: 1,
          });
        }
        try {
          const result = store.supersedePersonalDurable({
            userId: owner, memoryId, expectedRevision, content, authority, authorityBasis,
            ...(applicabilityScope !== undefined ? { applicabilityScope } : {}),
            evidence, actorId: `cli:personal:${owner}`,
          });
          console.log(JSON.stringify({ ok: true, result }));
        } catch (err) {
          console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          process.exitCode = 1;
        }
        return;
      }
      if (action === "forget") {        const { PrivateMemoryMutationStore } = await import("../src/private-memory-mutation-store.js");
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
        // Canonical owner resolves from the installation manifest only; a
        // conflicting env/flag never redefines it, and an absent manifest
        // fails closed rather than falling back.
        let primaryOwner: string;
        try {
          const { resolveOwnerSnapshot } = await import("../src/user-utils.js");
          primaryOwner = resolveOwnerSnapshot(abmindHome());
        } catch (err) {
          console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          process.exitCode = 1;
          return;
        }
        const decisions = JSON.parse(readFileSync(decisionsPath, "utf-8")) as never;
        console.log(JSON.stringify({ ok: true, result: applyPersonalConversion(db, decisions as never, { verifiedBackupPath: backupPath, primaryOwner }) }));
        return;
      }
      if (action === "projection-inspect" || action === "projection-build" || action === "projection-vectors") {
        // Projection maintenance targets the canonical manifest primary only.
        // A conflicting --user-id/env never redefines it; an absent manifest
        // fails closed rather than guessing an owner.
        const { resolveOwnerSnapshot } = await import("../src/user-utils.js");
        let primaryOwner: string;
        try {
          primaryOwner = resolveOwnerSnapshot(abmindHome());
        } catch (err) {
          console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          process.exitCode = 1;
          return;
        }
        if (args["user-id"] !== undefined && String(args["user-id"]) !== primaryOwner) {
          console.log(JSON.stringify({ ok: false, error: `--user-id must be the installation primary (${primaryOwner})` }));
          process.exitCode = 1;
          return;
        }
        if (action === "projection-inspect") {
          const { inspectRecallProjection } = await import("../src/recall-projection-build.js");
          console.log(JSON.stringify({ ok: true, plan: inspectRecallProjection(db, primaryOwner) }));
          return;
        }
        if (action === "projection-build") {
          const { buildRecallProjection } = await import("../src/recall-projection-build.js");
          const backupPath = args["backup"] !== undefined ? String(args["backup"]) : undefined;
          if (!backupPath) {
            console.log(JSON.stringify({ ok: false, error: "--backup <verified-backup> required" }));
            process.exitCode = 1;
            return;
          }
          if (!verifyBackupFile(backupPath)) {
            console.log(JSON.stringify({ ok: false, error: "backup verification failed — create and verify one first" }));
            process.exitCode = 1;
            return;
          }
          console.log(JSON.stringify({ ok: true, result: buildRecallProjection(db, primaryOwner, { verifiedBackup: true }) }));
          return;
        }
        // Derived-only backfill: computes missing serving-generation doc
        // vectors and CAS-publishes them. No backup gate (rebuildable), but
        // the personal route must be ready.
        const { backfillRecallVectors } = await import("../src/recall-projection-build.js");
        const { loadEmbedConfig, embedText } = await import("../src/ollama-embed.js");
        const config = loadEmbedConfig();
        console.log(JSON.stringify({
          ok: true,
          result: await backfillRecallVectors(db, primaryOwner, (text) => embedText(config, text)),
        }));
        return;
      }
      if (action === "reown-inspect" || action === "reown-apply") {
        const { inspectReown, applyPersonalReown } = await import("../src/personal-reown.js");
        const { resolveOwnerSnapshot } = await import("../src/user-utils.js");
        let primaryOwner: string;
        try {
          primaryOwner = resolveOwnerSnapshot(abmindHome());
        } catch (err) {
          console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          process.exitCode = 1;
          return;
        }
        if (action === "reown-inspect") {
          console.log(JSON.stringify({ ok: true, plan: inspectReown(db, primaryOwner) }));
          return;
        }
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
        console.log(JSON.stringify({ ok: true, result: applyPersonalReown(db, decisions as never, { verifiedBackupPath: backupPath, primaryOwner }) }));
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
