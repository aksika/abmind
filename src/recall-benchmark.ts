/**
 * recall-benchmark — measures recall pipeline efficacy.
 *
 * Runs a set of test queries against the live memory.db, captures per-stage
 * hits, timing, and unique contribution. Outputs JSON + human-readable summary.
 *
 * Usage:
 *   npx tsx src/memory/recall-benchmark.ts
 *   npx tsx src/memory/recall-benchmark.ts --queries path/to/queries.json
 *   npx tsx src/memory/recall-benchmark.ts --snapshot  (dump golden set template)
 */

import type BetterSqlite3 from "better-sqlite3";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let _BenchDb: typeof BetterSqlite3 | null = null;
function getBenchDatabase(): typeof BetterSqlite3 { if (!_BenchDb) _BenchDb = require("better-sqlite3") as typeof BetterSqlite3; return _BenchDb; }
import { MemoryIndex } from "./memory-index.js";
import { recallSearch, type RecallDeps, type RecallParams, type RecallResult, type RecallHit } from "./recall-engine.js";
import { abmindHome } from "./mem-paths.js";

// ── Types ───────────────────────────────────────────────────────────────────

interface TestQuery {
  /** Human-readable label */
  label: string;
  /** Keywords to search (passed as translated[]) */
  keywords: string[];
  /** Optional original-language keyword */
  original?: string;
  /** Memory IDs that are relevant (golden labels, filled manually) */
  relevantIds?: number[];
}

interface StageStats {
  totalHits: number;
  uniqueHits: number;
  totalMs: number;
  queriesWithHits: number;
}

interface QueryResult {
  label: string;
  keywords: string[];
  totalResults: number;
  shortCircuitAfter: string | null;
  extractedIds: number[];
  stages: Record<string, { hits: number; uniqueHits: number; ms: number }>;
  topResults: Array<{ content: string; source: string; score: number }>;
}

interface BenchmarkReport {
  timestamp: string;
  dbPath: string;
  memoryCount: number;
  messageCount: number;
  queryCount: number;
  stageStats: Record<string, StageStats>;
  /** Which stages never contributed a unique result across all queries */
  deadStages: string[];
  /** Per-query breakdown */
  queries: QueryResult[];
  /** Only present when golden labels exist */
  precision?: { mean: number; perQuery: Array<{ label: string; p10: number; r10: number; mrr: number }> };
}

// ── Default queries ─────────────────────────────────────────────────────────

const DEFAULT_QUERIES: TestQuery[] = [
  // Personal facts
  { label: "user name", keywords: ["user", "name"] },
  { label: "user language", keywords: ["Hungarian", "English", "language"], original: "magyar" },
  { label: "user environment", keywords: ["WSL", "environment"], original: "környezet" },
  { label: "user preferences", keywords: ["pizza", "cheese"], original: "sajt" },
  { label: "user communication style", keywords: ["frustration", "meta-commentary"] },
  // Technical facts
  { label: "deploy commands", keywords: ["deploy", "scripts"] },
  { label: "heartbeat interval", keywords: ["heartbeat", "interval"] },
  { label: "whisper STT", keywords: ["whisper", "voice", "transcription"] },
  { label: "FTS5 Hungarian", keywords: ["FTS5", "Hungarian", "agglutination"] },
  { label: "recall pipeline stages", keywords: ["recall", "pipeline", "stages"] },
  // Decisions
  { label: "prompt file security", keywords: ["prompt", "security", "moved"] },
  { label: "classification system", keywords: ["NATO", "classification", "SECRET"] },
  { label: "emotion scoring", keywords: ["emotion", "scoring", "under-detecting"] },
  { label: "mnt/c forbidden", keywords: ["mnt", "forbidden", "Windows"] },
  { label: "A2A memory policy", keywords: ["A2A", "memory", "tool"] },
  // Events
  { label: "Twitter access", keywords: ["Twitter", "X.com", "cookie"] },
  { label: "daily AI news cron", keywords: ["AI", "news", "cron", "daily"] },
  { label: "vision capability", keywords: ["vision", "image", "Telegram"] },
  { label: "refactor deployment", keywords: ["refactor", "deployed", "preparation"] },
  { label: "Spain trip", keywords: ["Fuengirola", "Spain", "Easter"] },
  // Lessons
  { label: "pivot on failures", keywords: ["pivot", "failures", "Browsie"] },
  { label: "search before bluffing", keywords: ["search", "bluffing", "szerda"] },
  { label: "lead with content", keywords: ["lead", "content", "narration"] },
  { label: "never claim unavailable", keywords: ["unavailable", "tool", "bash"] },
  { label: "translation fix policy", keywords: ["translation", "fix", "edit"] },
  // Cross-cutting
  { label: "Molty", keywords: ["Molty", "OpenClaw", "Mac"] },
  { label: "Browsie agent", keywords: ["Browsie", "browser", "subagent"] },
  { label: "cron monitoring", keywords: ["cron", "monitoring", "lastExit"] },
  { label: "self-healing", keywords: ["self-healing", "heartbeat", "errors"] },
  { label: "entity recall", keywords: ["entity", "entities", "tagged"] },
  // Bilingual — S2 tests (original-language queries)
  { label: "HU: password/jelszó", keywords: ["password"], original: "jelszó" },
  { label: "HU: authorization/engedély", keywords: ["authorization"], original: "engedélyezési" },
  { label: "HU: Home Assistant/eszközök", keywords: ["Home Assistant"], original: "eszközök" },
  { label: "HU: Mac environment", keywords: ["Mac"], original: "környezet" },
  { label: "HU: memory test", keywords: ["memory test"], original: "memória teszt" },
  // Edge cases — vague queries
  { label: "vague: what happened Tuesday", keywords: ["Tuesday"] },
  { label: "vague: email", keywords: ["email"] },
  { label: "vague: bug", keywords: ["bug"] },
  // Edge cases — Hungarian only (no English keyword)
  { label: "Hungarian: szundi", keywords: ["szundi"], original: "szundi" },
  { label: "Hungarian: kedd", keywords: ["kedd"], original: "kedd" },
  // Negative — should return few/no results
  { label: "negative: quantum computing", keywords: ["quantum", "computing", "qubit"] },
  { label: "negative: kubernetes", keywords: ["kubernetes", "k8s", "pod"] },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildDeps(dbPath: string): RecallDeps {
  const db = new (getBenchDatabase())(dbPath, { readonly: true });
  // Register custom SQL functions needed by recall-engine
  db.function("strip_emojis", (text: unknown) => {
    if (typeof text !== "string") return text;
    return text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "").replace(/ {2,}/g, " ").trim();
  });
  db.function("strip_diacritics", (text: unknown) => {
    if (typeof text !== "string") return text;
    return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  });
  const index = new MemoryIndex(db);
  const home = abmindHome();
  return {
    db,
    index,
    memoryDir: join(home, "memory"),
  };
}

function uniqueContribution(stageHits: RecallHit[], allPriorHits: Set<string>): number {
  let unique = 0;
  for (const h of stageHits) {
    const key = h.content.slice(0, 80);
    if (!allPriorHits.has(key)) { unique++; allPriorHits.add(key); }
  }
  return unique;
}

function computePrecision(_results: RecallHit[], relevantIds: number[], extractedIds: number[]): { p10: number; r10: number; mrr: number } {
  const relevant = new Set(relevantIds);
  const top10 = extractedIds.slice(0, 10);
  const hits = top10.filter(id => relevant.has(id)).length;
  const p10 = top10.length > 0 ? hits / top10.length : 0;
  const r10 = relevant.size > 0 ? hits / relevant.size : 0;
  const firstRelevant = top10.findIndex(id => relevant.has(id));
  const mrr = firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0;
  return { p10, r10, mrr };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbPath = join(abmindHome(), "memory", "memory.db");

  if (!existsSync(dbPath)) { console.error(`DB not found: ${dbPath}`); process.exit(1); }

  // Load queries
  let queries: TestQuery[] = DEFAULT_QUERIES;
  const queriesFlag = args.indexOf("--queries");
  if (queriesFlag >= 0 && args[queriesFlag + 1]) {
    queries = JSON.parse(readFileSync(args[queriesFlag + 1]!, "utf-8")) as TestQuery[];
  }

  // Snapshot mode: dump golden set template
  if (args.includes("--snapshot")) {
    const deps = buildDeps(dbPath);
    const db = deps.db;
    const memories = db.prepare("SELECT id, SUBSTR(content_en, 1, 150) as preview FROM extracted_memories ORDER BY id").all() as Array<{ id: number; preview: string }>;
    const template = queries.map(q => ({ ...q, relevantIds: [] as number[], _memories: "see below" }));
    const out = { queries: template, memories };
    const outPath = join(abmindHome(), "memory", "recall-golden-set.json");
    writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log(`Golden set template written to ${outPath}`);
    console.log(`${memories.length} memories, ${queries.length} queries`);
    console.log("Fill in relevantIds[] for each query, then run: npx tsx src/memory/recall-benchmark.ts --queries ${outPath}");
    db.close();
    return;
  }

  const deps = buildDeps(dbPath);
  const db = deps.db;
  const memoryCount = (db.prepare("SELECT COUNT(*) as c FROM extracted_memories").get() as { c: number }).c;
  const messageCount = (db.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c;

  // Detect the primary userId (most memories)
  const primaryChatId = (db.prepare(
    "SELECT user_id, COUNT(*) as cnt FROM extracted_memories GROUP BY user_id ORDER BY cnt DESC LIMIT 1",
  ).get() as { user_id: string })?.user_id ?? process.env["ABMIND_USER_ID"];

  if (!primaryChatId) { console.error("No memories found and ABMIND_USER_ID not set"); db.close(); process.exit(1); }

  console.log(`\nRecall Benchmark — ${memoryCount} memories, ${messageCount} messages, ${queries.length} queries (userId=${primaryChatId})\n`);

  const stageStats: Record<string, StageStats> = {};
  const queryResults: QueryResult[] = [];
  const hasGolden = queries.some(q => q.relevantIds && q.relevantIds.length > 0);
  const precisionResults: Array<{ label: string; p10: number; r10: number; mrr: number }> = [];

  for (const q of queries) {
    const params: RecallParams = {
      translated: q.keywords,
      original: q.original,
      userId: primaryChatId,
      limit: 10,
      trackRecalls: false,
    };

    const result: RecallResult = await recallSearch(deps, params);
    const seen = new Set<string>();
    const stageBreakdown: Record<string, { hits: number; uniqueHits: number; ms: number }> = {};

    // Process stages in pipeline order
    for (const [stageName, stageResult] of Object.entries(result.stages)) {
      const uniq = uniqueContribution(stageResult.hits, seen);
      stageBreakdown[stageName] = { hits: stageResult.hits.length, uniqueHits: uniq, ms: stageResult.ms };

      if (!stageStats[stageName]) stageStats[stageName] = { totalHits: 0, uniqueHits: 0, totalMs: 0, queriesWithHits: 0 };
      stageStats[stageName]!.totalHits += stageResult.hits.length;
      stageStats[stageName]!.uniqueHits += uniq;
      stageStats[stageName]!.totalMs += stageResult.ms;
      if (stageResult.hits.length > 0) stageStats[stageName]!.queriesWithHits++;
    }

    const qr: QueryResult = {
      label: q.label,
      keywords: q.keywords,
      totalResults: result.results.length,
      shortCircuitAfter: result.shortCircuitAfter,
      extractedIds: result.extractedIds,
      stages: stageBreakdown,
      topResults: result.results.slice(0, 5).map(r => ({
        content: r.content.slice(0, 120),
        source: r.source,
        score: Math.round(r.score * 1000) / 1000,
      })),
    };
    queryResults.push(qr);

    // Precision if golden labels exist
    if (q.relevantIds && q.relevantIds.length > 0) {
      const p = computePrecision(result.results, q.relevantIds, result.extractedIds);
      precisionResults.push({ label: q.label, ...p });
    }

    // Console progress
    const stageHits = Object.entries(stageBreakdown)
      .filter(([, v]) => v.hits > 0)
      .map(([k, v]) => `${k}:${v.hits}(${v.uniqueHits}u)`)
      .join(" ");
    console.log(`  ${q.label.padEnd(35)} → ${result.results.length} results  [${stageHits}]${result.shortCircuitAfter ? `  sc:${result.shortCircuitAfter}` : ""}`);
  }

  // Dead stages
  const deadStages = Object.entries(stageStats)
    .filter(([, s]) => s.uniqueHits === 0)
    .map(([name]) => name);

  // Build report
  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    dbPath,
    memoryCount,
    messageCount,
    queryCount: queries.length,
    stageStats,
    deadStages,
    queries: queryResults,
  };

  if (hasGolden && precisionResults.length > 0) {
    const meanP = precisionResults.reduce((s, p) => s + p.p10, 0) / precisionResults.length;
    report.precision = { mean: meanP, perQuery: precisionResults };
  }

  // Write report
  const outDir = join(abmindHome(), "memory", "benchmarks");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `recall-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  // Summary
  console.log("\n── Stage Summary ──────────────────────────────────────────────");
  console.log("Stage".padEnd(8), "Hits".padStart(6), "Unique".padStart(8), "Avg ms".padStart(8), "Queries".padStart(9));
  for (const [name, s] of Object.entries(stageStats).sort(([a], [b]) => a.localeCompare(b))) {
    const avgMs = queries.length > 0 ? Math.round(s.totalMs / queries.length) : 0;
    const marker = s.uniqueHits === 0 ? " ← DEAD" : "";
    console.log(name.padEnd(8), String(s.totalHits).padStart(6), String(s.uniqueHits).padStart(8), String(avgMs).padStart(8), `${s.queriesWithHits}/${queries.length}`.padStart(9), marker);
  }

  if (deadStages.length > 0) {
    console.log(`\n⚠️  Dead stages (zero unique hits across all queries): ${deadStages.join(", ")}`);
  }

  if (report.precision) {
    console.log(`\n── Precision (golden labels) ──────────────────────────────────`);
    console.log(`Mean P@10: ${(report.precision.mean * 100).toFixed(1)}%`);
    for (const p of report.precision.perQuery) {
      console.log(`  ${p.label.padEnd(35)} P@10=${(p.p10 * 100).toFixed(0)}%  R@10=${(p.r10 * 100).toFixed(0)}%  MRR=${p.mrr.toFixed(2)}`);
    }
  }

  console.log(`\nReport saved: ${outPath}`);
  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
