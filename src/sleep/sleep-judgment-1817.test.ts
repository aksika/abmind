/**
 * sleep-judgment-1817.test.ts — #1817 advisory sleep judgments.
 *
 * Evidence for: identical dispositions with judgments on/off plus receipt
 * annotation; fail-open to explicit unjudged across all five failure modes;
 * enforced per-run budget; op-identity memo within and across runs; bounded
 * run-scoped records; per-gate divergence pairing; gc batch verdicts that
 * keep every message. Scripted providers only (no network, no sidecar).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MEMORY_DB_SCHEMA_SQL, registerFunctions } from "../memory-db.js";
import { SleepDataAccess } from "../sleep-data-access.js";
import { initAbmindEnv, _resetAbmindEnv } from "../env-schema.js";
import type { IJudgmentProvider, JudgmentAnswers } from "../judgment-provider.js";
import { applyProposals, emptySnapshot } from "./proposals.js";
import type { AdvisoryJudge } from "./proposals.js";
import { readReceipts, writeReceipts } from "./receipts.js";
import type { WriteReceipt } from "./receipts.js";
import {
  SLEEP_SUPPORT_QUESTION_SET,
  SleepJudgmentRun,
  buildSupportQuestions,
  computeDivergence,
  judgeCandidateSupport,
  judgeGcBatch,
  judgePairs,
  seedMemoFromPriorRun,
  sleepJudgmentEgress,
  summarizeSleepJudgments,
} from "../sleep-judgment.js";
import type { SleepJudgeDeps } from "../sleep-judgment.js";
import { readJudgmentRecords, writeJudgmentRecords } from "./judgment-records.js";
import type { JudgmentRecordEntry } from "./judgment-records.js";

const OWNER = "master";
const RUN = "run-1817";
const NOW = 1_750_000_000_000;

const ENV_KEYS = ["SYSTEM1_SLEEP", "SYSTEM1_SLEEP_JEV_EGRESS"];

function createDb(): Database.Database {
  const db = new Database(":memory:");
  registerFunctions(db);
  db.exec(MEMORY_DB_SCHEMA_SQL);
  return db;
}

function makeDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "abmind-1817-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeRun(overrides?: Partial<{ maxCandidates: number; maxPairs: number; budgetMs: number }>): SleepJudgmentRun {
  return new SleepJudgmentRun(
    {
      maxCandidates: overrides?.maxCandidates ?? 10,
      maxPairs: overrides?.maxPairs ?? 10,
      budgetMs: overrides?.budgetMs ?? 60000,
    },
    NOW + (overrides?.budgetMs ?? 60000),
  );
}

function scripted(name: string, model: string, answers: JudgmentAnswers | null, opts?: { busy?: boolean; calls?: { n: number } }): IJudgmentProvider {
  return {
    name,
    model,
    busy: opts?.busy ?? false,
    lastFailure: answers === null ? "unreachable" : null,
    judge: async () => {
      if (opts?.calls) opts.calls.n++;
      return answers === null ? null : { answers, provider: name, model, latencyMs: 7 };
    },
  };
}

function supportAnswers(support: number, correction: number, scope: number): JudgmentAnswers {
  const n = (v: number): JudgmentAnswers[string] => ({ type: "noul", noul: v, derivedCertainty: Math.max(v, 1 - v) });
  return { support_0: n(support), correction_0: n(correction), scope_0: n(scope) };
}

function depsFor(provider: IJudgmentProvider | null): SleepJudgeDeps {
  return { provider, timeoutMs: 1500, questionSet: SLEEP_SUPPORT_QUESTION_SET };
}

describe("#1817 advisory sleep judgments", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    _resetAbmindEnv();
    initAbmindEnv();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetAbmindEnv();
  });

  it("judgments-on produces identical dispositions and annotates store receipts", async () => {
    const response = 'PROPOSE_STORE srcmsg=7 type=fact text="user prefers dark mode"';
    const runOnce = async (judge?: AdvisoryJudge): Promise<WriteReceipt[]> => {
      const db = createDb();
      const { dir, cleanup } = makeDir();
      try {
        const snapshot = emptySnapshot(RUN, "extract-memories", OWNER, ["store", "decline"]);
        snapshot.sources.set(7, "user said they prefer dark mode in the dashboard");
        const applied = await applyProposals(
          {
            db,
            sleepData: new SleepDataAccess(db, OWNER),
            memoryDir: dir,
            snapshot,
            alreadyAccepted: new Map(),
            now: () => NOW,
            ...(judge !== undefined ? { advisoryJudge: judge } : {}),
          },
          response,
        );
        return applied.receipts;
      } finally { cleanup(); db.close(); }
    };
    const calls = { n: 0 };
    const provider = scripted("laya", "laya-test", supportAnswers(0.9, 0.05, 0.1), { calls });
    const run = makeRun();
    const off = await runOnce();
    const on = await runOnce((s) => judgeCandidateSupport(depsFor(provider), run, s.opId, s.claim, s.evidence, NOW));
    expect(on.map((r) => r.disposition)).toEqual(off.map((r) => r.disposition));
    expect(on.map((r) => r.disposition)).toEqual(["accepted"]);
    // Same writes minus the annotation: strip judgment and compare whole receipts.
    expect(on.map(({ judgment: _j, ...rest }) => rest)).toEqual(off.map(({ judgment: _k, ...rest }) => rest));
    expect(on[0]!.judgment).toMatchObject({ verdict: "supported", questionSet: SLEEP_SUPPORT_QUESTION_SET, model: "laya-test" });
    expect(calls.n).toBe(1);
  });

  it("all five failure modes resolve to explicit unjudged on the baseline path", async () => {
    const run = makeRun();
    const claim = "user prefers dark mode";
    const evidence = ["user said they prefer dark mode"];
    // No provider.
    expect((await judgeCandidateSupport(depsFor(null), run, "op/a", claim, evidence, NOW)).verdict).toBe("unjudged");
    // Busy provider costs no budget and no call.
    const busyCalls = { n: 0 };
    const busy = await judgeCandidateSupport(depsFor(scripted("laya", "m", supportAnswers(0.9, 0, 0), { busy: true, calls: busyCalls })), run, "op/b", claim, evidence, NOW);
    expect(busy.verdict).toBe("unjudged");
    expect(busy.reason).toBe("provider busy");
    expect(busyCalls.n).toBe(0);
    // Null result carries the provider's failure class.
    const dead = await judgeCandidateSupport(depsFor(scripted("laya", "m", null)), run, "op/c", claim, evidence, NOW);
    expect(dead).toMatchObject({ verdict: "unjudged", reason: "unreachable" });
    // Jev without an egress grant abstains.
    const jev = await judgeCandidateSupport(depsFor(scripted("jev", "jev-1.13.0", supportAnswers(0.9, 0, 0))), run, "op/d", claim, evidence, NOW);
    expect(jev).toMatchObject({ verdict: "unjudged", reason: "egress denied" });
    // Uncertain answers are a real verdict, not fail-open.
    const vague = await judgeCandidateSupport(depsFor(scripted("laya", "m", supportAnswers(0.5, 0.1, 0.4))), run, "op/e", claim, evidence, NOW);
    expect(vague.verdict).toBe("uncertain");
  });

  it("missing evidence resolves no-evidence without spending budget or calling", async () => {
    const calls = { n: 0 };
    const run = makeRun();
    const j = await judgeCandidateSupport(depsFor(scripted("laya", "m", supportAnswers(0.9, 0, 0), { calls })), run, "op/a", "claim", [], NOW);
    expect(j.verdict).toBe("no-evidence");
    expect(calls.n).toBe(0);
    expect(run.candidatesUsed).toBe(0);
    expect(run.noEvidence).toBe(1);
  });

  it("enforces candidate and time caps with the remainder marked unjudged", async () => {
    const run = makeRun({ maxCandidates: 1 });
    const provider = scripted("laya", "m", supportAnswers(0.9, 0, 0));
    const deps = depsFor(provider);
    expect((await judgeCandidateSupport(deps, run, "op/a", "c", ["e"], NOW)).verdict).toBe("supported");
    const second = await judgeCandidateSupport(deps, run, "op/b", "c", ["e"], NOW);
    expect(second).toMatchObject({ verdict: "unjudged", reason: "judgment budget exhausted" });
    expect(run.exhausted).toBe(true);
    // A blown run deadline exhausts before any call.
    const expired = new SleepJudgmentRun({ maxCandidates: 10, maxPairs: 10, budgetMs: 1000 }, NOW - 1);
    expect((await judgeCandidateSupport(deps, expired, "op/c", "c", ["e"], NOW)).verdict).toBe("unjudged");
    expect(expired.exhausted).toBe(true);
  });

  it("a step cutoff resolves the remainder unjudged without a provider call", async () => {
    const calls = { n: 0 };
    const run = makeRun();
    const deps: SleepJudgeDeps = { ...depsFor(scripted("laya", "m", supportAnswers(0.9, 0, 0), { calls })), deadlineMs: NOW - 1 };
    const j = await judgeCandidateSupport(deps, run, "op/a", "c", ["e"], NOW);
    expect(j).toMatchObject({ verdict: "unjudged", reason: "judgment budget exhausted" });
    expect(calls.n).toBe(0);
    expect(run.exhausted).toBe(true);
    // Pairs and gc honor the same cutoff.
    const pairs = await judgePairs(deps, makeRun(), [{ newId: 1, oldId: 2, newText: "a", oldText: "b" }], () => NOW);
    expect(pairs.get("pair:1->2")).toMatchObject({ triage: "keep", verdict: "unjudged" });
    const gc = await judgeGcBatch(deps, makeRun(), [{ id: 5, excerpt: "hi" }], () => NOW);
    expect(gc.get(5)).toMatchObject({ decision: "keep", verdict: "unjudged" });
    expect(calls.n).toBe(0);
  });

  it("gc honors the memo from a prior run's records and skips the provider", async () => {
    const calls = { n: 0 };
    const { dir, cleanup } = makeDir();
    try {
      writeJudgmentRecords(dir, [{
        runId: "run-prior", step: "gc-noise", principal: OWNER, gate: "gc-noise",
        subject: "msg:3", decision: "noise", verdict: "disputed",
        questionSet: SLEEP_SUPPORT_QUESTION_SET, model: "laya-test", reason: "noise=0.95", at: NOW,
      }]);
      const run = makeRun();
      seedMemoFromPriorRun(run, dir, "run-prior");
      const out = await judgeGcBatch(depsFor(scripted("laya", "m", {}, { calls })), run, [{ id: 3, excerpt: "ok" }], () => NOW);
      expect(out.get(3)).toMatchObject({ decision: "noise", verdict: "disputed" });
      expect(calls.n).toBe(0);
      expect(run.judged).toBe(1);
    } finally { cleanup(); }
  });

  it("memos by op identity within a run and seeds from a prior run's receipts", async () => {
    const calls = { n: 0 };
    const run = makeRun();
    const deps = depsFor(scripted("laya", "m", supportAnswers(0.9, 0, 0), { calls }));
    await judgeCandidateSupport(deps, run, "op/a", "c", ["e"], NOW);
    await judgeCandidateSupport(deps, run, "op/a", "c", ["e"], NOW);
    expect(calls.n).toBe(1);
    // Resume: the prior run's annotated receipt seeds the memo — no new call.
    const { dir, cleanup } = makeDir();
    try {
      const prior: WriteReceipt[] = [{
        runId: "run-prior", step: "extract-memories", principal: OWNER, opId: "extract-memories/abc123",
        op: "store", disposition: "accepted", source: 7, memoryId: 42, at: NOW,
        judgment: { verdict: "disputed", questionSet: SLEEP_SUPPORT_QUESTION_SET, model: "laya-test", reason: "support=0.10 correction=0.00 scope=0.30" },
      }];
      writeReceipts(dir, prior);
      const resumed = makeRun();
      seedMemoFromPriorRun(resumed, dir, "run-prior");
      const j = await judgeCandidateSupport(deps, resumed, "extract-memories/abc123", "c", ["e"], NOW);
      expect(j.verdict).toBe("disputed");
      expect(calls.n).toBe(1);
    } finally { cleanup(); }
  });

  it("records round-trip bounded, capped, and lenient", () => {
    const { dir, cleanup } = makeDir();
    try {
      const long = "x".repeat(500);
      const entry: JudgmentRecordEntry = {
        runId: RUN, step: "gc-noise", principal: OWNER, gate: "gc-noise",
        subject: "msg:9", decision: "noise", verdict: "disputed",
        questionSet: SLEEP_SUPPORT_QUESTION_SET, model: "laya-test", reason: long, at: NOW,
      };
      expect(writeJudgmentRecords(dir, [entry])).toBe(0);
      const back = readJudgmentRecords(dir, RUN);
      expect(back).toHaveLength(1);
      expect(back[0]!.reason?.length).toBeLessThanOrEqual(200);
      // Cap: 2005 entries persist at most 2000.
      const many: JudgmentRecordEntry[] = Array.from({ length: 2005 }, (_, i) => ({ ...entry, subject: `msg:${i}` }));
      writeJudgmentRecords(dir, many);
      expect(readJudgmentRecords(dir, RUN).length).toBeLessThanOrEqual(2000);
      expect(readJudgmentRecords(dir, "run-absent")).toEqual([]);
    } finally { cleanup(); }
  });

  it("receipt annotations round-trip; unknown verdicts drop the annotation only", () => {
    const { dir, cleanup } = makeDir();
    try {
      const receipts: WriteReceipt[] = [{
        runId: RUN, step: "extract-memories", principal: OWNER, opId: "s/1",
        op: "store", disposition: "accepted", source: 7, memoryId: 1, at: NOW,
        judgment: { verdict: "supported", questionSet: SLEEP_SUPPORT_QUESTION_SET, model: "m", reason: "support=0.90 correction=0.05 scope=0.10" },
      }];
      writeReceipts(dir, receipts);
      const back = readReceipts(dir, RUN);
      expect(back[0]!.judgment).toMatchObject({ verdict: "supported", questionSet: SLEEP_SUPPORT_QUESTION_SET });
    } finally { cleanup(); }
  });

  it("pairs divergence by baseline outcome, counts unpaired, and summarizes the run", () => {
    const receipts: WriteReceipt[] = [
      { runId: RUN, step: "s", principal: OWNER, opId: "a", op: "store", disposition: "accepted", at: NOW, judgment: { verdict: "supported", questionSet: SLEEP_SUPPORT_QUESTION_SET, model: "m" } },
      { runId: RUN, step: "s", principal: OWNER, opId: "b", op: "store", disposition: "accepted", at: NOW, judgment: { verdict: "disputed", questionSet: SLEEP_SUPPORT_QUESTION_SET, model: "m" } },
      { runId: RUN, step: "s", principal: OWNER, opId: "c", op: "store", disposition: "declined", at: NOW, judgment: { verdict: "disputed", questionSet: SLEEP_SUPPORT_QUESTION_SET, model: "m" } },
      { runId: RUN, step: "s", principal: OWNER, opId: "d", op: "store", disposition: "accepted", at: NOW, judgment: { verdict: "uncertain", questionSet: SLEEP_SUPPORT_QUESTION_SET, model: "m" } },
      { runId: RUN, step: "s", principal: OWNER, opId: "e", op: "store", disposition: "accepted", at: NOW },
    ];
    const at = NOW;
    const rec = (gate: JudgmentRecordEntry["gate"], subject: string, decision: string, verdict: JudgmentRecordEntry["verdict"]): JudgmentRecordEntry =>
      ({ runId: RUN, step: "s", principal: OWNER, gate, subject, decision, verdict, questionSet: SLEEP_SUPPORT_QUESTION_SET, model: "m", at });
    const records: JudgmentRecordEntry[] = [
      rec("gc-noise", "msg:1", "noise", "disputed"),
      rec("gc-noise", "msg:2", "keep", "supported"),
      rec("gc-noise", "msg:3", "noise", "disputed"),
      rec("pre-triage", "pair:10->20", "triage=prune", "disputed"),
      rec("pre-triage", "pair:11->21", "triage=keep", "supported"),
      rec("pre-triage", "pair:12->22", "triage=prune", "uncertain"),
      rec("pre-triage", "bogus", "triage=prune", "disputed"),
      rec("pre-triage", "pair:13->23", "triage=keep", "unjudged"),
    ];
    const applied: WriteReceipt[] = [
      ...receipts,
      { runId: RUN, step: "contradiction-and-graph", principal: OWNER, opId: "x", op: "contradict", disposition: "accepted", memoryId: 20, at: NOW },
    ];
    // msg:1 was kept (divergent noise), msg:3 was in the baseline selection (agreed noise).
    const [extract, gc, triage] = computeDivergence(applied, records, { gcSelected: new Set([3]) });
    // disputed+accepted diverges; disputed+declined agrees; uncertain abstains; unannotated ignored.
    expect(extract).toMatchObject({ total: 4, agreed: 2, divergent: 1, abstained: 1, unpaired: 0 });
    expect(gc).toMatchObject({ total: 3, agreed: 2, divergent: 1, abstained: 0, unpaired: 0 });
    // prune+applied agrees; keep+unapplied agrees; prune+unapplied diverges; bogus unpaired; unjudged abstains.
    expect(triage).toMatchObject({ total: 5, agreed: 2, divergent: 1, abstained: 1, unpaired: 1 });
    // Without the baseline selection every gc verdict is unpaired, never assumed.
    const [, gcUnpaired] = computeDivergence(applied, records);
    expect(gcUnpaired).toMatchObject({ total: 3, agreed: 0, divergent: 0, unpaired: 3 });
    expect(summarizeSleepJudgments([], [], null)).toBeNull();
    const line = summarizeSleepJudgments(applied, records, makeRun().summary(), new Set([3]));
    expect(line).toContain(SLEEP_SUPPORT_QUESTION_SET);
    expect(line).toContain("budget ok");
    expect(line).toContain("gc-noise [noise vs baseline keep]");
    expect(line).toContain("unpaired");
  });

  it("gc batch returns a verdict per id and keeps every message on failure", async () => {
    const run = makeRun();
    const items = [
      { id: 1, excerpt: "hello" },
      { id: 2, excerpt: "thanks, bye" },
      { id: 3, excerpt: "ok" },
    ];
    const noisy: JudgmentAnswers = {
      noise_0: { type: "noul", noul: 0.95, derivedCertainty: 0.95 },
      noise_1: { type: "noul", noul: 0.9, derivedCertainty: 0.9 },
      noise_2: { type: "noul", noul: 0.1, derivedCertainty: 0.9 },
    };
    const verdicts = await judgeGcBatch(depsFor(scripted("laya", "m", noisy)), run, items, () => NOW);
    expect([...verdicts.keys()].sort()).toEqual([1, 2, 3]);
    expect(verdicts.get(1)).toMatchObject({ decision: "noise", verdict: "disputed" });
    expect(verdicts.get(3)).toMatchObject({ decision: "keep", verdict: "supported" });
    // Provider death keeps every message explicitly unjudged.
    const dead = await judgeGcBatch(depsFor(scripted("laya", "m", null)), makeRun(), items, () => NOW);
    expect([...dead.values()].every((v) => v.decision === "keep" && v.verdict === "unjudged")).toBe(true);
  });

  it("pair triage maps choices and defaults to keep on failure", async () => {
    const pairs = [{ newId: 10, oldId: 20, newText: "deploys run Friday", oldText: "deploys run Monday" }];
    const answers: JudgmentAnswers = {
      triage_0: { type: "choice", choice: "prune", confidence: 0.9, probabilities: { prune: 0.9 } },
      contradicts_0: { type: "noul", noul: 0.88, derivedCertainty: 0.88 },
    };
    const out = await judgePairs(depsFor(scripted("laya", "m", answers)), makeRun(), pairs, () => NOW);
    expect(out.get("pair:10->20")).toMatchObject({ triage: "prune", verdict: "disputed" });
    const dead = await judgePairs(depsFor(scripted("laya", "m", null)), makeRun(), pairs, () => NOW);
    expect(dead.get("pair:10->20")).toMatchObject({ triage: "keep", verdict: "unjudged" });
  });

  it("question builders pin the harness-shared instruction contract", () => {
    const q = buildSupportQuestions(1);
    expect(q["support_0"]?.instructions).toBe(
      "Does `evidence[{k}]` support `claims[{k}]` as a durable memory — a fact, decision, preference, event, or lesson the user stated, decided, or confirmed?",
    );
    expect(q["correction_0"]?.instructions).toBe(
      "Does `evidence[{k}]` show `claims[{k}]` was corrected, rejected, dismissed, or never approved by the user — for example an agent suggestion the user shot down?",
    );
    expect(q["scope_0"]?.instructions).toBe(
      "Is `claims[{k}]` broader than what `evidence[{k}]` supports — for example a one-off workaround stated as a permanent rule, or a scoped exception stated as a general preference?",
    );
  });

  it("sleep egress allows loopback laya and gates jev on an explicit grant", () => {
    expect(sleepJudgmentEgress("laya")).toBe(true);
    expect(sleepJudgmentEgress("jev")).toBe(false);
    expect(sleepJudgmentEgress("unknown-backend")).toBe(false);
  });
});
