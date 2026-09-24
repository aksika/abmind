#!/usr/bin/env node
/**
 * scripts/measure-compact-delivery.mjs — A8 measurement for #1813.
 *
 * Representative broad pull through the real recallSearch composition (no
 * provider, no flags): records full vs selected injected payload, result
 * counts, recall latency, and model-call counts against baseline. The
 * deterministic selection makes zero model calls by construction; this lane
 * measures what it saves, not what it judges.
 *
 * Usage: npm run build && node scripts/measure-compact-delivery.mjs
 * Exit 0 with a JSON report on stdout (logs on stderr).
 */

import { initializeDatabase } from "../dist/src/memory-db.js";
import { MemoryIndex } from "../dist/src/memory-index.js";
import { recallSearch, SELECTION_BUDGET_BYTES } from "../dist/src/recall-engine.js";

const MEMORIES = [
  "Production deploys run via /deploy prod after CI passes on main.",
  "Production rollbacks use /rollback prod within one hour of a bad deploy.",
  "Staging deploys run on every merge to main without approval.",
  "Ask the operator before deploying changes to the production database.",
  "Deploy notifications go to the team channel after each production release.",
  "Feature flags for deploys live in the rollout config with owner tags. " + "x".repeat(900),
  "The deploy runbook covers database migration order and rollback windows in detail for on-call engineers. " + "y".repeat(1400),
  "Canary deploys shift five percent of traffic first and watch error budgets. " + "z".repeat(600),
  "The user prefers dark mode in the dashboard.",
  "Deploy freeze calendar blocks releases during public holidays each year.",
];

function seed(db) {
  const now = Date.now();
  const stmt = db.prepare(`INSERT INTO extracted_memories
    (content_en, content_original, memory_type, created_at, source_timestamp, user_id, confidence, emotion_score, recall_count, relevance_score)
    VALUES (?, ?, 'fact', ?, ?, 'measure-user', 3, 0, 0, 0)`);
  for (const content of MEMORIES) stmt.run(content, content, now, now);
}

async function main() {
  const db = initializeDatabase(":memory:");
  try {
    seed(db);
    const deps = { db, index: new MemoryIndex(db), memoryDir: "/tmp/measure-compact" };
    const params = { translated: ["deploy"], userId: "measure-user", limit: 10, stages: ["Sf"] };

    // Warm-up, then median of 5 for latency.
    await recallSearch(deps, params);
    const times = [];
    let res = null;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      res = await recallSearch(deps, params);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const medianMs = times[2];

    const byId = new Map(res.results.filter((h) => typeof h.id === "number").map((h) => [h.id, h]));
    const fullBytes = res.results.reduce((s, h) => s + Buffer.byteLength(h.content, "utf8"), 0);
    const selRefs = res.selection?.refs ?? [];
    const selBytes = selRefs.reduce((s, r) => s + Buffer.byteLength(byId.get(r.id)?.content ?? "", "utf8"), 0);
    const constraintKept = selRefs.some((r) => (byId.get(r.id)?.content ?? "").includes("Ask the operator"));

    console.log(JSON.stringify({
      backend: "none (deterministic selection, no provider)",
      modelCalls: 0,
      results: res.results.length,
      selectedRefs: selRefs.length,
      fullPayloadBytes: fullBytes,
      selectedPayloadBytes: selBytes,
      savedBytes: fullBytes - selBytes,
      savedPct: fullBytes === 0 ? 0 : Math.round((100 * (fullBytes - selBytes)) / fullBytes),
      budgetBytes: SELECTION_BUDGET_BYTES,
      truncated: res.selection?.truncated ?? null,
      constraintRetained: constraintKept,
      recallMedianMs: Math.round(medianMs * 10) / 10,
    }, null, 2));
  } finally {
    db.close();
  }
}

await main();
