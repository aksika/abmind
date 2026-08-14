/**
 * abmind repair-attribution — operator-reviewed legacy attribution repair.
 *
 * Usage:
 *   abmind repair-attribution --from-users <id,id,...> [--decisions <json>] [--private-decisions <json>] [--apply]
 *
 * Default is dry-run: prints the reviewed plan (rows, collisions,
 * classification >= 2 rows, stale watermarks) as JSON plus a summary.
 * --apply re-inspects, refuses any unresolved per-row decision, creates a
 * verified encrypted backup in ~/.abmind/backups/, then applies the repair in
 * one transaction. Target owner is always the canonical primary identity; there
 * is no --to-user.
 */

import { join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { runCliRaw } from "../src/cli-runner-raw.js";
import type { FlagSpec } from "../src/cli-flags.js";
import { initializeDatabase } from "../src/memory-db.js";
import { abmindHome } from "../src/mem-paths.js";
import { createBackup } from "../src/backup.js";
import { requirePrimaryUserId } from "../src/user-utils.js";
import { ABMIND_VERSION } from "../src/_version.js";
import {
  inspectAttributionRepair,
  applyAttributionRepair,
  type AttributionRepairPlan,
  type CollisionDecision,
  type PrivateRowDecision,
} from "../src/extracted-memory-attribution-repair.js";
import { hostname } from "node:os";

const BACKUP_MAGIC = Buffer.from("ABMIND\x00\x01");

const FLAGS: readonly FlagSpec[] = [
  { name: "from-users", type: "string" },
  { name: "decisions", type: "string" },
  { name: "private-decisions", type: "string" },
  { name: "apply", type: "boolean" },
  { name: "passphrase", type: "string" },
  { name: "passphrase-env", type: "string" },
];

function timestamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function parseDecisionJson<T>(raw: string | undefined, label: string, isApply: boolean): T[] {
  if (!isApply) return [];
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be a JSON array`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array`);
  return parsed as T[];
}

function validateDecisionShape(decisions: readonly unknown[], label: string): void {
  for (const decision of decisions) {
    if (decision === null || typeof decision !== "object") {
      throw new Error(`${label} entries must be objects`);
    }
    const entry = decision as { sourceMemoryId?: unknown; action?: unknown };
    if (typeof entry.sourceMemoryId !== "number" || !Number.isSafeInteger(entry.sourceMemoryId) || entry.sourceMemoryId < 1) {
      throw new Error(`${label} entries require a positive integer sourceMemoryId`);
    }
    if (typeof entry.action !== "string") {
      throw new Error(`${label} entries require an action string`);
    }
  }
}

function printSummary(plan: AttributionRepairPlan): void {
  console.log(`source rows (owner correction): ${plan.rows.length}`);
  console.log(`content_en collisions: ${plan.collisions.length}`);
  for (const collision of plan.collisions) {
    console.log(`  collision source=${collision.sourceMemoryId} -> target=${collision.targetMemoryId} content="${collision.contentEn.slice(0, 80)}"`);
  }
  console.log(`classification >= 2 rows: ${plan.privateRows.length}`);
  for (const privateRow of plan.privateRows) {
    console.log(`  private id=${privateRow.sourceMemoryId} classification=${privateRow.classification} contentLength=${privateRow.contentEnLength}`);
  }
  console.log(`stale watermarks: ${plan.staleWatermarkUserIds.length > 0 ? plan.staleWatermarkUserIds.join(", ") : "none"}`);
}

function verifyBackup(path: string): { path: string; bytes: number; verified: boolean } {
  const stat = existsSync(path) ? statSync(path) : null;
  if (!stat || stat.size < 54) throw new Error(`backup not created or truncated: ${path}`);
  const head = readFileSync(path).subarray(0, 8);
  if (!head.equals(BACKUP_MAGIC)) throw new Error(`backup file does not have the abmind header: ${path}`);
  return { path, bytes: stat.size, verified: true };
}

function verifyPostApply(db: unknown, targetUserId: string, sourceUserIds: readonly string[], plan: AttributionRepairPlan): Record<string, unknown> {
  const database = db as import("better-sqlite3").Database;
  const placeholders = sourceUserIds.map(() => "?").join(",");
  const remaining = database.prepare(
    `SELECT user_id, COUNT(*) as count FROM extracted_memories WHERE user_id IN (${placeholders}) GROUP BY user_id ORDER BY user_id`,
  ).all(...sourceUserIds) as Array<{ user_id: string; count: number }>;

  const correctedIds = plan.rows.map((row) => row.id);
  const ftsCount = correctedIds.length > 0
    ? (database.prepare(`SELECT COUNT(*) as c FROM extracted_memories_fts WHERE rowid IN (${correctedIds.map(() => "?").join(",")})`).get(...correctedIds) as { c: number }).c
    : 0;

  const targetCount = (database.prepare("SELECT COUNT(*) as c FROM extracted_memories WHERE user_id = ?").get(targetUserId) as { c: number }).c;
  const remainingWatermarks = database.prepare(
    `SELECT user_id FROM extraction_watermarks WHERE user_id IN (${placeholders}) ORDER BY user_id`,
  ).all(...sourceUserIds) as Array<{ user_id: string }>;

  return {
    remainingSourceOwners: remaining,
    targetOwnerCount: targetCount,
    ftsIndexedCorrectedIds: ftsCount,
    remainingWatermarks: remainingWatermarks.map((row) => row.user_id),
  };
}

await runCliRaw(import.meta.url, {
  name: "abmind-repair-attribution",
  banner: "repair-attribution",
  help: `Usage:
  abmind repair-attribution --from-users <id,id,...> [--decisions <json>] [--private-decisions <json>] [--apply]

Options:
  --from-users <csv>       Exact source owner ids (comma separated). Required.
  --decisions <json>       Per-row collision decisions: [{"sourceMemoryId":<id>,"action":"merge"|"drop-source"},...]
  --private-decisions <json> Per-row classification>=2 decisions: [{"sourceMemoryId":<id>,"action":"relabel"|"leave"|"delete"},...]
  --apply                  Apply after a fresh inspection, verified encrypted backup and full decisions
  --passphrase <p>         Backup encryption passphrase (default: from ~/.abmind/secret/abmind.key)
  --passphrase-env <VAR>   Read backup passphrase from env var

The target owner is always the canonical primary identity (ABMIND_USER_ID /
manifest.json encryptionUser). Dry-run is the default and the only safe mode
without --apply. Never infer source owners: every id passed to --from-users is
exactly the set that may be repaired.`,
  flags: FLAGS,
  handler: async ({ args }) => {
    const fromUsers = (args["from-users"] as string | undefined)?.trim();
    if (!fromUsers) {
      console.error("Error: --from-users is required");
      process.exit(1);
    }
    const sourceUserIds = fromUsers.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
    if (sourceUserIds.length === 0) {
      console.error("Error: --from-users requires at least one user id");
      process.exit(1);
    }

    let targetUserId: string;
    try {
      targetUserId = requirePrimaryUserId();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
    if (sourceUserIds.includes(targetUserId)) {
      console.error("Error: target primary user cannot also be a source user");
      process.exit(1);
    }

    const isApply = !!args["apply"];
    const collisionDecisions = parseDecisionJson<CollisionDecision>(args["decisions"] as string | undefined, "--decisions", isApply);
    const privateRowDecisions = parseDecisionJson<PrivateRowDecision>(args["private-decisions"] as string | undefined, "--private-decisions", isApply);
    validateDecisionShape(collisionDecisions, "--decisions");
    validateDecisionShape(privateRowDecisions, "--private-decisions");

    const home = abmindHome();
    const memoryDir = join(home, "memory");
    const db = initializeDatabase(join(memoryDir, "memory.db"));
    try {
      const request = {
        targetUserId,
        sourceUserIds,
        collisionDecisions,
        privateRowDecisions,
      };

      const plan = inspectAttributionRepair(db, request);
      const summary = {
        ok: true,
        dryRun: !isApply,
        targetUserId,
        sourceUserIds,
        plan: {
          rows: plan.rows.map((row) => ({ id: row.id, sourceUserId: row.sourceUserId })),
          collisions: plan.collisions,
          privateRows: plan.privateRows,
          staleWatermarkUserIds: plan.staleWatermarkUserIds,
        },
      };
      console.log(JSON.stringify(summary, null, 2));
      printSummary(plan);

      if (!isApply) {
        if (plan.collisions.length > 0 || plan.privateRows.length > 0) {
          console.log("Dry-run only: unresolved collisions / classification>=2 rows require per-row decisions before --apply.");
        }
        return;
      }

      const unresolvedCollisions = plan.collisions.filter(
        (collision) => !collisionDecisions.some((decision) => decision.sourceMemoryId === collision.sourceMemoryId),
      );
      const unresolvedPrivate = plan.privateRows.filter(
        (privateRow) => !privateRowDecisions.some((decision) => decision.sourceMemoryId === privateRow.sourceMemoryId),
      );
      if (unresolvedCollisions.length > 0 || unresolvedPrivate.length > 0) {
        const missing = [
          ...unresolvedCollisions.map((collision) => `collision ${collision.sourceMemoryId}`),
          ...unresolvedPrivate.map((privateRow) => `private ${privateRow.sourceMemoryId}`),
        ];
        throw new Error(`apply refused: missing decisions for ${missing.join(", ")}`);
      }

      const envVar = (args["passphrase-env"] as string) ?? "ABMIND_BACKUP_PASSPHRASE";
      const passphrase = (args["passphrase"] as string) ?? process.env[envVar] ?? undefined;
      const backupsDir = join(home, "backups");
      const backupPath = join(backupsDir, `repair-attribution-${timestamp()}.abm`);
      const backup = createBackup(db, memoryDir, passphrase, backupPath, { dbOnly: true });
      const verified = verifyBackup(backup.path);

      const result = applyAttributionRepair(db, request, plan);
      const postApply = verifyPostApply(db, targetUserId, sourceUserIds, plan);

      const evidence = {
        ok: true,
        host: hostname(),
        command: "abmind repair-attribution",
        commandVersion: ABMIND_VERSION,
        targetUserId,
        sourceUserIds,
        backup: verified,
        result,
        postApply,
      };
      console.log(JSON.stringify(evidence, null, 2));
    } finally {
      db.close();
    }
  },
});
