/**
 * epic32-sleep-pipeline.test.ts — Epic #1868 final E2E acceptance.
 *
 * Two journeys through the production sleep orchestrator and settlement path
 * (real orchestration, evidence preparation, owner policy, storage, watermark,
 * file writes, candidate boundary, and recall). Only the two nondeterministic
 * boundaries the epic allows to be fixtured are fixtured: the generative
 * model turn (MockRuntime) and the System One judgment boundary (scripted
 * IJudgmentProvider in the second journey).
 *
 * Journey 1 (baseline, judgments off): seeded multi-principal history →
 * failed extraction leaves the source unhandled and the watermark held →
 * fixed run stores the canary with a source-linked receipt, surfaces an
 * outside-set contradiction as rejected without touching the target row,
 * keeps the second principal out of the master daily/weekly/S6/recall →
 * a failed previous day leaves no recoverable debt while the next normal
 * run re-covers from the watermark without duplicates → two nightly runs
 * publish exactly one weekly.
 *
 * Journey 2 (System One utilized): same shape with SYSTEM1_SLEEP on and a
 * scripted provider — supported/disputed annotations ride the baseline
 * dispositions, the run record reports them, and a provider-less rerun
 * completes on the baseline path marked explicitly unjudged with identical
 * dispositions.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSleepCycle } from "./orchestrator.js";
import { setupTestEnv, type TestEnv } from "./test-harness.js";
import type { SleepRunOptions } from "./contracts.js";
import { getMemoryDb } from "../memory-manager.js";
import { initAbmindEnv, _resetAbmindEnv } from "../env-schema.js";
import type { IJudgmentProvider, JudgmentAnswers } from "../judgment-provider.js";
import { SLEEP_SUPPORT_QUESTION_SET } from "../sleep-judgment.js";
import { readReceipts } from "./receipts.js";
import { searchConsolidationFiles } from "../consolidation-search.js";
import { CONSOLIDATION_COMPLETE_MARKER } from "./sleep-daily-summary.js";
import { enumerateDays } from "./consolidation-cadence.js";

const MASTER = "master";
const OTHER = "other-user";
const CANARY_TEXT = "the harbor pantry stocks oat milk for friday tastings";
const BIKE_TEXT = "user decided to bike to work on fridays";
const OTHER_TEXT = "zephyratelier summit moved to tuesday at noon";
const FILLER_ONE = "lol ok see you later then";
const FILLER_TWO = "thanks, that call was short";
const TARGET_ID = 5001;
const TARGET_TEXT = "quartz wall clock chimes hourly in the study";

const COMPLETE_RESPONSE = `# Weekly — summary

## Events
- a decision was made

${CONSOLIDATION_COMPLETE_MARKER}
`;

function baseOpts(env: TestEnv, overrides: Partial<SleepRunOptions> = {}): SleepRunOptions {
  return {
    runtime: env.runtime,
    memoryManager: env.memory,
    now: () => env.now,
    timeoutMs: 120_000,
    fresh: true,
    betweenStepBackoffMs: () => 0,
    memoryConfigOverride: { memoryDir: env.memoryDir, memoryEnabled: true },
    ...overrides,
  };
}

function seedChat(env: TestEnv, items: Array<{ userId: string; content: string; minutesAgo: number }>): number[] {
  const ids: number[] = [];
  for (const item of items) {
    const id = env.memory.recordMessage({
      role: "user",
      content: item.content,
      timestamp: env.now - item.minutesAgo * 60_000,
      userId: item.userId,
      sessionId: `${item.userId}:telegram`,
    });
    if (id === null) throw new Error(`test seeding: recordMessage refused ${item.content}`);
    ids.push(id);
  }
  return ids;
}

function seedTargetRow(env: TestEnv): void {
  const db = getMemoryDb(env.memory)!;
  // Well-formed defaults (trust/credibility/integrity/created_at) so the
  // maintenance fix-defaults pass leaves the row untouched: the test owns
  // the revision, not the repair path.
  db.prepare(
    `INSERT INTO extracted_memories
       (id, user_id, content_original, content_en, memory_type, source_timestamp, created_at,
        valid_to, classification, semantic_revision, tier, trust, credibility, integrity)
     VALUES (?, ?, ?, ?, 'fact', 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(TARGET_ID, MASTER, TARGET_TEXT, TARGET_TEXT, env.now - 60_000, null, 1, 1, "general", 2, 4, 2);
}

function cannedCommon(env: TestEnv): void {
  env.runtime.setDefault("ok");
  env.runtime.setResponse(
    "Update the summary incorporating",
    `- harbor pantry stocks oat milk for friday tastings per user decision\n- bike commute on fridays decided\n- call notes without durable content worth more than fifty characters total here`,
  );
  env.runtime.setResponse("retrospective", "Today went well. Nothing flagged.");
  env.runtime.setResponse("Mark small talk", "[]");
}

/** Extraction double: stores known durable texts, declines known filler, and
 *  emits nothing for anything else — an unoffered or leaked id stays
 *  unhandled loudly instead of passing silently. */
function extractionBuilder(
  env: TestEnv,
  durable: Map<number, string>,
  filler: Set<number>,
  omit: Set<number>,
): (prompt: string) => string {
  return (prompt: string) => {
    const lines: string[] = [];
    const re = /\[src=(\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(prompt)) !== null) {
      const id = parseInt(m[1]!, 10);
      if (omit.has(id)) continue;
      const text = durable.get(id);
      if (text !== undefined) {
        lines.push(`PROPOSE_STORE srcmsg=${id} type=fact text="${text}"`);
      } else if (filler.has(id)) {
        lines.push(`DECLINE srcmsg=${id} reason="chit-chat with no durable content"`);
      }
    }
    return lines.join("\n");
  };
}

/** Contradiction double naming an owned but unshown target: the boundary must
 *  reject it and leave the row active at its displayed revision. */
function rejectionBuilder(env: TestEnv): (prompt: string) => string {
  return () => {
    const db = getMemoryDb(env.memory)!;
    const row = db.prepare("SELECT id FROM extracted_memories WHERE content_en = ? AND valid_to IS NULL").get(CANARY_TEXT) as { id: number } | undefined;
    if (!row) return "NO_CONTRADICTIONS";
    return `CONTRADICT old_id=${TARGET_ID} new_id=${row.id} reason="superseded by the pantry update"`;
  };
}

function seedWeek(env: TestEnv, start: string, end: string): void {
  for (const day of enumerateDays(start, end)) {
    const dir = join(env.memoryDir, "daily");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `daily_${day}-0000Z.md`), `# Daily Summary ${day}\nOwner: ${MASTER}\n\n- event on ${day}\n`);
  }
}

function readWatermark(env: TestEnv): number {
  const db = getMemoryDb(env.memory)!;
  const row = db.prepare("SELECT last_processed_timestamp FROM extraction_watermarks ORDER BY last_processed_timestamp DESC LIMIT 1").get() as { last_processed_timestamp: number } | undefined;
  return row?.last_processed_timestamp ?? 0;
}

function stampedDailies(env: TestEnv): string[] {
  return readdirSync(env.dailyDir).filter((f) => /^daily_\d{4}-\d{2}-\d{2}-\d{4}Z\.md$/.test(f));
}

function injectProvider(env: TestEnv, provider: IJudgmentProvider | null): void {
  (env.memory as unknown as { judgmentProvider: IJudgmentProvider | null }).judgmentProvider = provider;
}

function noul(v: number): JudgmentAnswers[string] {
  return { type: "noul", noul: v, derivedCertainty: Math.max(v, 1 - v) };
}

describe("epic32 final E2E acceptance", () => {
  it("baseline journey: canary survives, outsiders stay out, failures surface, normal run recovers without duplicates, one weekly", async () => {
    const env = await setupTestEnv({ today: "2026-04-20" });
    try {
      const [canaryId, fillerOneId, fillerTwoId, otherId] = seedChat(env, [
        { userId: MASTER, content: CANARY_TEXT, minutesAgo: 40 },
        { userId: MASTER, content: FILLER_ONE, minutesAgo: 30 },
        { userId: MASTER, content: FILLER_TWO, minutesAgo: 20 },
        { userId: OTHER, content: OTHER_TEXT, minutesAgo: 10 },
      ]) as [number, number, number, number];
      seedTargetRow(env);
      cannedCommon(env);
      const durable = new Map([[canaryId, CANARY_TEXT]]);
      const filler = new Set([fillerOneId, fillerTwoId]);
      const omit = new Set<number>([canaryId]);
      env.runtime.setBuilder("PROPOSAL-EXTRACTION-V1", extractionBuilder(env, durable, filler, omit));
      env.runtime.setBuilder("Contradiction Check", rejectionBuilder(env));

      // Run 1: the canary is omitted — the step must fail loudly, the
      // watermark must hold, and nothing may claim the canary was handled.
      const failed = await runSleepCycle(baseOpts(env));
      expect(failed.status, "omitted candidate must not be a silent success").not.toBe("completed");
      expect(failed.essentialFailures).toContain("extract-memories");
      expect(readWatermark(env), "watermark must hold behind the gap").toBe(0);
      const db = getMemoryDb(env.memory)!;
      expect(
        db.prepare("SELECT COUNT(*) AS c FROM extracted_memories WHERE content_en = ?").get(CANARY_TEXT),
      ).toEqual({ c: 0 });

      // Run 2: complete pass — canary stored with a source-linked receipt,
      // filler explicitly declined, outsider never offered, contradiction
      // outside the shown set rejected with the target row intact. Manual
      // mode bypasses the no-messages guard so the rerun exercises the steps.
      omit.clear();
      const done = await runSleepCycle(baseOpts(env, { mode: "manual" }));
      expect(done.status).toBe("completed");
      expect(done.watermarkAdvanced).toBe(true);
      expect(readWatermark(env)).toBeGreaterThan(0);
      const stored = db.prepare("SELECT id FROM extracted_memories WHERE content_en = ? AND valid_to IS NULL").get(CANARY_TEXT) as { id: number } | undefined;
      expect(stored, "canary must survive message to sleep").toBeDefined();
      const receipts = readReceipts(env.memoryDir, done.runId);
      const accepted = receipts.find((r) => r.op === "store" && r.disposition === "accepted" && r.source === canaryId);
      expect(accepted, "source-linked accepted receipt for the canary").toBeDefined();
      const declined = receipts.find((r) => r.op === "decline" && r.disposition === "declined" && r.source === fillerOneId);
      expect(declined, "filler must carry an explicit declined receipt").toBeDefined();
      expect(receipts.some((r) => r.source === otherId), "second principal must never be offered").toBe(false);
      const offered = new Set<number>();
      for (const call of env.runtime.allCalls()) {
        if (!call.prompt.includes("PROPOSAL-EXTRACTION-V1") || call.runId !== done.runId) continue;
        const re = /\[src=(\d+)\]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(call.prompt)) !== null) offered.add(parseInt(m[1]!, 10));
      }
      expect([...offered], "decided filler is replayed without model redispatch").toEqual([canaryId]);
      const rejected = receipts.find((r) => r.op === "contradict" && r.disposition === "rejected");
      expect(rejected?.reason, "outside-set contradiction must be rejected and surfaced").toContain("shown");
      const target = db.prepare("SELECT valid_to, semantic_revision FROM extracted_memories WHERE id = ?").get(TARGET_ID) as { valid_to: string | null; semantic_revision: number };
      expect(target.valid_to, "rejected target stays active").toBeNull();
      expect(target.semantic_revision, "rejected target keeps its revision").toBe(1);

      // The master daily carries the canary; the second principal's material
      // appears in no master daily.
      const dailies = stampedDailies(env);
      expect(dailies.length).toBeGreaterThan(0);
      expect(dailies.some((f) => readFileSync(join(env.dailyDir, f), "utf-8").includes("harbor pantry"))).toBe(true);
      for (const f of dailies) {
        expect(readFileSync(join(env.dailyDir, f), "utf-8"), "outsider absent from master dailies").not.toContain("zephyratelier");
      }

      // Recall: the canary answers the master; the outsider never surfaces,
      // including at the S6 consolidation stage.
      const recall = await env.memory.recallSearch({ translated: ["oat milk"], userId: MASTER, limit: 5 });
      expect(recall.results.some((h) => h.content.includes("oat milk")), "canary reachable via recall").toBe(true);
      const outsiderRecall = await env.memory.recallSearch({ translated: ["zephyratelier"], userId: MASTER, limit: 5 });
      expect(outsiderRecall.results.some((h) => h.content.includes("zephyratelier")), "outsider absent from master recall").toBe(false);
      const s6Hits = outsiderRecall.stages["S6"]?.hits ?? [];
      expect(s6Hits.some((h) => h.content.includes("zephyratelier")), "outsider absent from master S6").toBe(false);
      expect(
        searchConsolidationFiles(env.memoryDir, ["zephyratelier"], { requesterUserId: MASTER }),
        "outsider absent from master S6",
      ).toHaveLength(0);

      // Cadence: two consecutive nightly runs publish exactly one weekly, and
      // the weekly carries no second-principal material.
      seedWeek(env, "2026-04-13", "2026-04-19");
      env.runtime.setResponse(CONSOLIDATION_COMPLETE_MARKER, COMPLETE_RESPONSE);
      const cadenceOpts = { fresh: true, mode: "manual" } as const;
      const third = await runSleepCycle(baseOpts(env, cadenceOpts));
      expect(third.status).toBe("completed");
      const weeklyDir = join(env.memoryDir, "weekly");
      expect(readdirSync(weeklyDir)).toEqual(["weekly_2026-04-13_2026-04-19.md"]);
      const weekly = readFileSync(join(weeklyDir, "weekly_2026-04-13_2026-04-19.md"), "utf-8");
      expect(weekly).toContain("Owner: master");
      expect(weekly, "outsider absent from weekly").not.toContain("zephyratelier");
      const fourth = await runSleepCycle(baseOpts(env, cadenceOpts));
      expect(fourth.status).toBe("completed");
      expect(readdirSync(weeklyDir), "second nightly run publishes no second weekly").toEqual(["weekly_2026-04-13_2026-04-19.md"]);
    } finally {
      env.cleanup();
    }

    // Phase B — next-normal-run recovery in a second env (same journey test):
    // a failed previous day leaves no recoverable debt; the next normal run
    // re-covers retained messages from the watermark. A partial extraction
    // (one stored, one omitted, watermark held) followed by a fixed run
    // produces no duplicate accepted memories and advances the watermark.
    {
      const today = new Date();
      const format = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const previous = new Date(today);
      previous.setDate(previous.getDate() - 1);
      const previousIso = format(previous);
      const previousStr = previousIso.replace(/-/g, "");
      const PARTIAL_TWO_TEXT = "user renewed the library card for another year";
      const recoveryEnv = await setupTestEnv({
        today: format(today),
        seedMessages: 0,
        preseedPreviousDayLock: {
          dateStr: previousStr,
          steps: {
            "daily-summary": { status: "failed" },
            retrospective: { status: "failed" },
            "extract-memories": { status: "failed" },
          },
          ageDaysAtNow: 1,
        },
      });
      try {
        const prevLockBefore = readFileSync(join(recoveryEnv.sleepDir, `sleep_${previousStr}.lock`), "utf-8");
        const recoveryDb = getMemoryDb(recoveryEnv.memory)!;
        const yesterdayTs = recoveryEnv.now - 86400_000 + 3_600_000;
        recoveryDb.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)").run(
          MASTER, "master:telegram", "user", CANARY_TEXT, yesterdayTs,
        );
        recoveryDb.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)").run(
          MASTER, "master:telegram", "user", PARTIAL_TWO_TEXT, yesterdayTs + 60_000,
        );
        const rows = recoveryDb.prepare("SELECT id, content FROM messages WHERE user_id = ? ORDER BY id").all(MASTER) as Array<{ id: number; content: string }>;
        const msgId = (text: string): number => rows.find((r) => r.content === text)!.id;
        cannedCommon(recoveryEnv);
        recoveryEnv.runtime.setResponse(CONSOLIDATION_COMPLETE_MARKER, COMPLETE_RESPONSE);
        // Run 1: omit the second message — partial extraction stores the
        // canary, holds the watermark, and settles nothing for message two.
        recoveryEnv.runtime.setBuilder(
          "PROPOSAL-EXTRACTION-V1",
          extractionBuilder(recoveryEnv, new Map([[msgId(CANARY_TEXT), CANARY_TEXT]]), new Set(), new Set([msgId(PARTIAL_TWO_TEXT)])),
        );
        const partial = await runSleepCycle(baseOpts(recoveryEnv));
        expect(partial.status, "partial extraction must not report completed").not.toBe("completed");
        expect(readWatermark(recoveryEnv), "watermark held behind the unhandled message").toBe(0);
        const countRows = (): number => (recoveryDb.prepare("SELECT COUNT(*) AS c FROM extracted_memories WHERE valid_to IS NULL").get() as { c: number }).c;
        expect(countRows(), "one accepted memory after the partial run").toBe(1);

        // Run 2 is on a new date with no same-day receipt lineage. The model
        // would reword the canary if offered; its frozen decision must replay.
        recoveryEnv.runtime.setBuilder(
          "PROPOSAL-EXTRACTION-V1",
          extractionBuilder(
            recoveryEnv,
            new Map([[msgId(CANARY_TEXT), "Oat milk is available at the harbor pantry for Friday tastings."], [msgId(PARTIAL_TWO_TEXT), PARTIAL_TWO_TEXT]]),
            new Set(),
            new Set(),
          ),
        );
        const recovered = await runSleepCycle(baseOpts(recoveryEnv, { now: () => recoveryEnv.now + 86400_000 }));
        expect(recovered.status).toBe("completed");
        expect(recovered.watermarkAdvanced).toBe(true);
        expect(readWatermark(recoveryEnv)).toBeGreaterThan(0);
        expect(countRows(), "no duplicate accepted memories after re-cover").toBe(2);
        const retryCalls = recoveryEnv.runtime.allCalls().filter((c) => c.runId === recovered.runId && c.prompt.includes("PROPOSAL-EXTRACTION-V1"));
        expect(retryCalls.length).toBeGreaterThan(0);
        for (const call of retryCalls) {
          expect(call.prompt).not.toContain(`[src=${msgId(CANARY_TEXT)}]`);
          expect(call.prompt).toContain(`[src=${msgId(PARTIAL_TWO_TEXT)}]`);
        }
        const recoveredReceipts = readReceipts(recoveryEnv.memoryDir, recovered.runId);
        expect(
          recoveredReceipts.some((r) => r.step === "extract-memories" && r.op === "store" && r.disposition === "accepted" && r.source === msgId(CANARY_TEXT)),
          "repeated offer carries an accepted (reconciled) receipt",
        ).toBe(true);
        expect(
          recoveredReceipts.some((r) => r.step === "extract-memories" && r.op === "store" && r.disposition === "accepted" && r.source === msgId(PARTIAL_TWO_TEXT)),
          "omitted message settles on the next normal run",
        ).toBe(true);
        // No historical-date dispatch in either run, and the old receipt file
        // is retained untouched.
        const historical = recoveryEnv.runtime.allCalls().filter((c) => c.stepId.startsWith("catch-up-"));
        expect(historical, "old receipts never dispatch historical recovery").toEqual([]);
        expect(readFileSync(join(recoveryEnv.sleepDir, `sleep_${previousStr}.lock`), "utf-8")).toBe(prevLockBefore);
      } finally {
        recoveryEnv.cleanup();
      }
    }
  });

  it("SystemOne journey: advisory verdicts ride the baseline, degraded completes unjudged with identical dispositions", async () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of ["SYSTEM1_SLEEP"]) { saved[k] = process.env[k]; delete process.env[k]; }
    _resetAbmindEnv();
    process.env["SYSTEM1_SLEEP"] = "on";
    initAbmindEnv();
    try {
      const scripted = (calls: { n: number }, supportCalls: { n: number }): IJudgmentProvider => ({
        name: "laya",
        model: "laya-e2e",
        busy: false,
        lastFailure: null,
        judge: async (_state, questions) => {
          calls.n++;
          if ("support_0" in questions) {
            supportCalls.n++;
            const supported = supportCalls.n === 1;
            return {
              answers: supported
                ? { support_0: noul(0.9), correction_0: noul(0.05), scope_0: noul(0.1) }
                : { support_0: noul(0.15), correction_0: noul(0.92), scope_0: noul(0.3) },
              provider: "laya",
              model: "laya-e2e",
              latencyMs: 1,
            };
          }
          const answers: JudgmentAnswers = {};
          for (const id of Object.keys(questions)) {
            if (id.startsWith("noise_") || id.startsWith("contradicts_")) answers[id] = noul(0.1);
            else if (id.startsWith("triage_")) {
              answers[id] = { type: "choice", choice: "keep", confidence: 0.9, probabilities: { keep: 0.9 } };
            }
          }
          return { answers, provider: "laya", model: "laya-e2e", latencyMs: 1 };
        },
      });

      const seed = (env: TestEnv): { canaryId: number; bikeId: number; fillerId: number } => {
        const [canaryId, bikeId, fillerId] = seedChat(env, [
          { userId: MASTER, content: CANARY_TEXT, minutesAgo: 30 },
          { userId: MASTER, content: BIKE_TEXT, minutesAgo: 20 },
          { userId: MASTER, content: FILLER_ONE, minutesAgo: 10 },
        ]) as [number, number, number];
        return { canaryId, bikeId, fillerId };
      };
      const serve = (env: TestEnv, ids: { canaryId: number; bikeId: number; fillerId: number }): void => {
        cannedCommon(env);
        env.runtime.setBuilder(
          "PROPOSAL-EXTRACTION-V1",
          extractionBuilder(
            env,
            new Map([[ids.canaryId, CANARY_TEXT], [ids.bikeId, BIKE_TEXT]]),
            new Set([ids.fillerId]),
            new Set(),
          ),
        );
      };
      const dispositionMap = (env: TestEnv, runId: string): Record<string, string> => {
        const out: Record<string, string> = {};
        for (const r of readReceipts(env.memoryDir, runId)) {
          if (r.op === "store" || r.op === "decline") out[r.opId] = r.disposition;
        }
        return out;
      };

      // Judged run: supported and disputed annotations on stored candidates.
      const judgedEnv = await setupTestEnv({ today: "2026-04-20" });
      const judgedCalls = { n: 0 };
      const judgedSupport = { n: 0 };
      try {
        const ids = seed(judgedEnv);
        serve(judgedEnv, ids);
        injectProvider(judgedEnv, scripted(judgedCalls, judgedSupport));
        const judged = await runSleepCycle(baseOpts(judgedEnv));
        expect(judged.status).toBe("completed");
        expect(judgedCalls.n, "provider consulted through the real seam").toBeGreaterThan(0);
        const receipts = readReceipts(judgedEnv.memoryDir, judged.runId);
        const canaryDb = getMemoryDb(judgedEnv.memory)!;
        const canaryMem = canaryDb.prepare("SELECT id FROM extracted_memories WHERE content_en = ? AND valid_to IS NULL").get(CANARY_TEXT) as { id: number } | undefined;
        const bikeMem = canaryDb.prepare("SELECT id FROM extracted_memories WHERE content_en = ? AND valid_to IS NULL").get(BIKE_TEXT) as { id: number } | undefined;
        expect(canaryMem, "supported candidate stored exactly as baseline stores it").toBeDefined();
        expect(bikeMem, "disputed candidate stored exactly as baseline stores it").toBeDefined();
        const canaryReceipt = receipts.find((r) => r.memoryId === canaryMem!.id && r.disposition === "accepted");
        const bikeReceipt = receipts.find((r) => r.memoryId === bikeMem!.id && r.disposition === "accepted");
        expect(canaryReceipt?.judgment?.verdict, "supported annotation rides the receipt").toBe("supported");
        expect(bikeReceipt?.judgment?.verdict, "disputed annotation rides the receipt").toBe("disputed");
        expect(canaryReceipt?.judgment?.questionSet).toBe(SLEEP_SUPPORT_QUESTION_SET);
        expect(judged.report, "run record reports the advisory layer").toContain("Sleep judgments (sleep-support-v1)");

        // Degraded run, same seeds, no provider: completes on the baseline
        // path with every verdict explicitly unjudged and identical
        // dispositions — no verdict changes what is stored. The null is
        // injected explicitly so the absence is deterministic even where a
        // local sidecar would otherwise boot a real provider.
        const degradedEnv = await setupTestEnv({ today: "2026-04-20" });
        try {
          const degradedIds = seed(degradedEnv);
          serve(degradedEnv, degradedIds);
          injectProvider(degradedEnv, null);
          const degraded = await runSleepCycle(baseOpts(degradedEnv));
          expect(degraded.status).toBe("completed");
          const degradedReceipts = readReceipts(degradedEnv.memoryDir, degraded.runId);
          const annotated = degradedReceipts.filter((r) => r.judgment !== undefined);
          expect(annotated.length, "fallback verdicts are recorded, not silent").toBeGreaterThan(0);
          expect(
            annotated.every((r) => r.judgment?.verdict === "unjudged"),
            "every fallback verdict is explicitly unjudged, never validated",
          ).toBe(true);
          expect(degraded.report).toContain("unjudged");
          expect(
            dispositionMap(degradedEnv, degraded.runId),
            "advisory changes no disposition",
          ).toEqual(dispositionMap(judgedEnv, judged.runId));
          const degradedDb = getMemoryDb(degradedEnv.memory)!;
          expect(degradedDb.prepare("SELECT COUNT(*) AS c FROM extracted_memories WHERE content_en = ?").get(CANARY_TEXT)).not.toEqual({ c: 0 });
        } finally {
          degradedEnv.cleanup();
        }
      } finally {
        judgedEnv.cleanup();
      }
    } finally {
      for (const k of ["SYSTEM1_SLEEP"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      _resetAbmindEnv();
    }
  });
});
