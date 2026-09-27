/**
 * proposals-1859.test.ts — #1859 bounded candidate boundary, receipts, and
 * knowledge budgets.
 *
 * Focused evidence for: selection fencing (unshown/foreign/stale ids),
 * transactional pair checks, retry reconciliation, disposition-complete
 * extraction, knowledge-file CAS and the 8 KiB budget, notes read truncation,
 * and proposal-only fail-closed dispatch.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MEMORY_DB_SCHEMA_SQL, registerFunctions } from "../memory-db.js";
import { SleepDataAccess } from "../sleep-data-access.js";
import {
  applyProposals,
  hashKnowledgeBytes,
  loadAcceptedReceipts,
  persistProposalReceipts,
  emptySnapshot,
  readKnowledgeVersion,
} from "./proposals.js";
import { applyNotesReadBudget, notesOmissionMarker, AGENT_NOTES_BUDGET_BYTES } from "../core-composition.js";
import { readReceipts } from "./receipts.js";
import { applyExtractionBatch } from "./extraction-proposals.js";
import type { OfferedMessage } from "./extraction-proposals.js";
import { setupTestEnv } from "./test-harness.js";
import { runSleepCycle } from "./orchestrator.js";
import type { SleepRunOptions, SleepRuntime } from "./contracts.js";

const OWNER = "master";
const RUN = "run-1859";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  registerFunctions(db);
  db.exec(MEMORY_DB_SCHEMA_SQL);
  return db;
}

function seedMemory(
  db: Database.Database,
  id: number,
  content: string,
  opts?: { userId?: string; validTo?: string | null; classification?: number; revision?: number; createdAt?: number; tier?: string },
): void {
  db.prepare(
    `INSERT INTO extracted_memories
       (id, user_id, content_original, content_en, memory_type, source_timestamp, created_at,
        valid_to, classification, semantic_revision, tier)
     VALUES (?, ?, ?, ?, 'fact', 0, ?, ?, ?, ?, ?)`,
  ).run(
    id, opts?.userId ?? OWNER, content, content,
    opts?.createdAt ?? 0, opts?.validTo ?? null, opts?.classification ?? 1, opts?.revision ?? 1, opts?.tier ?? "general",
  );
}

function makeDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "abmind-1859-"));
  mkdirSync(join(dir, "core"), { recursive: true });
  mkdirSync(join(dir, "sleep"), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function snapshotFor(db: Database.Database, step: string, eligible: Parameters<typeof emptySnapshot>[3]): ReturnType<typeof emptySnapshot> {
  return emptySnapshot(RUN, step, OWNER, eligible);
}

// ── Selection fencing ───────────────────────────────────────────────────────

describe("#1859 candidate boundary", () => {
  it("rejects a store naming an unoffered source and applies nothing", async () => {
    const db = createDb();
    const { dir, cleanup } = makeDir();
    try {
      const sleepData = new SleepDataAccess(db, OWNER);
      const snapshot = snapshotFor(db, "extract-memories", ["store", "decline"]);
      snapshot.sources.set(7, "user said something durable");
      const applied = await applyProposals(
        { db, sleepData, memoryDir: dir, snapshot, alreadyAccepted: new Map() },
        'PROPOSE_STORE srcmsg=999 type=fact text="unshown source"',
      );
      expect(applied.receipts).toHaveLength(1);
      expect(applied.receipts[0]!.disposition).toBe("rejected");
      expect(applied.receipts[0]!.reason).toContain("source");
      expect(db.prepare("SELECT COUNT(*) AS c FROM extracted_memories").get()).toEqual({ c: 0 });
    } finally { cleanup(); db.close(); }
  });

  it("contradicts only a shown, linked, current-revision pair; unlinked and stale pairs leave the row active", async () => {
    const db = createDb();
    const { dir, cleanup } = makeDir();
    try {
      const sleepData = new SleepDataAccess(db, OWNER);
      seedMemory(db, 10, "user prefers Opus", { revision: 3 });
      seedMemory(db, 20, "user prefers Sonnet", { revision: 2 });
      seedMemory(db, 30, "unrelated newer fact", { revision: 1 });
      for (const step of ["contradiction-and-graph"]) {
        // Unlinked pair (20 is shown but not linked to 10): rejected.
        const unlinked = emptySnapshot(RUN, step, OWNER, ["contradict"]);
        unlinked.shown.set(10, 3);
        unlinked.shown.set(20, 2);
        unlinked.currentRunNew.add(20);
        const r1 = await applyProposals(
          { db, sleepData, memoryDir: dir, snapshot: unlinked, alreadyAccepted: new Map() },
          'CONTRADICT old_id=10 new_id=20 reason="conflicting preferences"',
        );
        expect(r1.receipts[0]!.disposition).toBe("rejected");
        expect(r1.receipts[0]!.reason).toContain("linked");
        expect(db.prepare("SELECT valid_to FROM extracted_memories WHERE id = 10").get()).toEqual({ valid_to: null });

        // Linked pair with a stale old revision (bumped after the snapshot):
        // rejected, both rows unchanged.
        const stale = emptySnapshot(RUN, step, OWNER, ["contradict"]);
        stale.shown.set(10, 2);
        stale.shown.set(20, 2);
        stale.pairs.set(20, new Set([10]));
        stale.currentRunNew.add(20);
        const r2 = await applyProposals(
          { db, sleepData, memoryDir: dir, snapshot: stale, alreadyAccepted: new Map() },
          'CONTRADICT old_id=10 new_id=20 reason="revision race"',
        );
        expect(r2.receipts[0]!.disposition).toBe("rejected");
        expect(r2.receipts[0]!.reason).toContain("changed");
        expect(db.prepare("SELECT valid_to, semantic_revision FROM extracted_memories WHERE id = 10").get()).toEqual({ valid_to: null, semantic_revision: 3 });

        // Valid linked pair at the shown revisions: accepted under CAS.
        const valid = emptySnapshot(RUN, "contradiction-and-graph", OWNER, ["contradict"]);
        valid.shown.set(10, 3);
        valid.shown.set(20, 2);
        valid.pairs.set(20, new Set([10]));
        valid.currentRunNew.add(20);
        const r3 = await applyProposals(
          { db, sleepData, memoryDir: dir, snapshot: valid, alreadyAccepted: new Map() },
          'CONTRADICT old_id=10 new_id=20 reason="user switched preference"',
        );
        expect(r3.receipts[0]!.disposition).toBe("accepted");
        const old = db.prepare("SELECT valid_to FROM extracted_memories WHERE id = 10").get() as { valid_to: string | null };
        expect(old.valid_to).not.toBeNull();
        expect(db.prepare("SELECT valid_to FROM extracted_memories WHERE id = 20").get()).toEqual({ valid_to: null });
      }
    } finally { cleanup(); db.close(); }
  });

  it("rejects a foreign owner's id even when the number is shown", async () => {
    const db = createDb();
    const { dir, cleanup } = makeDir();
    try {
      const sleepData = new SleepDataAccess(db, OWNER);
      seedMemory(db, 10, "another user's fact", { userId: "someone-else" });
      const snapshot = snapshotFor(db, "contradiction-and-graph", ["contradict"]);
      // The snapshot builder only ever records owner-scoped rows; simulate a
      // forged snapshot showing the foreign id.
      snapshot.shown.set(10, 1);
      snapshot.shown.set(20, 1);
      snapshot.pairs.set(20, new Set([10]));
      snapshot.currentRunNew.add(20);
      seedMemory(db, 20, "owner's new fact");
      const result = await applyProposals(
        { db, sleepData, memoryDir: dir, snapshot, alreadyAccepted: new Map() },
        'CONTRADICT old_id=10 new_id=20 reason="forged owner"',
      );
      expect(result.receipts[0]!.disposition).toBe("rejected");
      expect(db.prepare("SELECT valid_to FROM extracted_memories WHERE id = 10").get()).toEqual({ valid_to: null });
    } finally { cleanup(); db.close(); }
  });

  it("reconciles an interrupted apply across a resume (new runId) with a receipt, without duplicate application", async () => {
    const db = createDb();
    const { dir, cleanup } = makeDir();
    try {
      const sleepData = new SleepDataAccess(db, OWNER);
      const response = 'PROPOSE_STORE srcmsg=7 type=fact text="the durable fact"';

      // Run A applies the store and persists its receipt.
      const first = snapshotFor(db, "extract-memories", ["store", "decline"]);
      first.sources.set(7, "user said something durable");
      const applied = await applyProposals({ db, sleepData, memoryDir: dir, snapshot: first, alreadyAccepted: new Map() }, response);
      persistProposalReceipts(dir, applied.receipts);
      expect(applied.receipts[0]!.disposition).toBe("accepted");

      // Resume gets a NEW runId; reconciliation must reach the prior run.
      const reconciled = loadAcceptedReceipts(dir, ["run-1859-resumed", RUN], "extract-memories");
      expect(reconciled.size).toBe(1);
      const resumed = snapshotFor(db, "extract-memories", ["store", "decline"]);
      resumed.runId = "run-1859-resumed";
      resumed.sources.set(7, "user said something durable");
      const second = await applyProposals({ db, sleepData, memoryDir: dir, snapshot: resumed, alreadyAccepted: reconciled }, response);
      expect(second.receipts).toHaveLength(1);
      expect(second.receipts[0]!.disposition, "the reconciled receipt keeps the source handled").toBe("accepted");
      expect(second.receipts[0]!.source).toBe(7);
      expect(second.receipts[0]!.reason).toContain("reconciled");
      expect(db.prepare("SELECT COUNT(*) AS c FROM extracted_memories").get()).toEqual({ c: 1 });

      // Same runId, same response: reconciliation also holds within one run.
      const inRun = loadAcceptedReceipts(dir, [RUN], "extract-memories");
      const third = await applyProposals({ db, sleepData, memoryDir: dir, snapshot: first, alreadyAccepted: inRun }, response);
      expect(third.receipts[0]!.disposition).toBe("accepted");
      expect(db.prepare("SELECT COUNT(*) AS c FROM extracted_memories").get()).toEqual({ c: 1 });
    } finally { cleanup(); db.close(); }
  });

  it("counts a duplicate proposal in one response once", async () => {
    const db = createDb();
    const { dir, cleanup } = makeDir();
    try {
      const sleepData = new SleepDataAccess(db, OWNER);
      const snapshot = snapshotFor(db, "feedback", ["relevance"]);
      seedMemory(db, 10, "recalled fact", { revision: 1 });
      snapshot.shown.set(10, 1);
      const applied = await applyProposals(
        { db, sleepData, memoryDir: dir, snapshot, alreadyAccepted: new Map() },
        'RELEVANCE id=10 delta=+10 reason="useful"\nRELEVANCE id=10 delta=+10 reason="useful"',
      );
      expect(applied.receipts).toHaveLength(2);
      expect(applied.receipts[1]!.reason).toContain("duplicate");
      const row = db.prepare("SELECT relevance_score FROM extracted_memories WHERE id = 10").get() as { relevance_score: number };
      expect(row.relevance_score).toBe(10);

      // A duplicate rejected proposal stays rejected — it never claims an
      // application that did not happen.
      const rejected = await applyProposals(
        { db, sleepData, memoryDir: dir, snapshot, alreadyAccepted: new Map() },
        'RELEVANCE id=999 delta=+10 reason="unknown id"\nRELEVANCE id=999 delta=+10 reason="unknown id"',
      );
      expect(rejected.receipts).toHaveLength(2);
      expect(rejected.receipts[0]!.disposition).toBe("rejected");
      expect(rejected.receipts[1]!.disposition).toBe("rejected");
    } finally { cleanup(); db.close(); }
  });

  it("applies RETRO_INVALIDATE on a shown, linked retro pair without a current-run gate", async () => {
    const db = createDb();
    const { dir, cleanup } = makeDir();
    try {
      const sleepData = new SleepDataAccess(db, OWNER);
      seedMemory(db, 40, "newer promoted preference", { revision: 2 });
      seedMemory(db, 55, "older contradicted rule", { revision: 1 });
      const snapshot = snapshotFor(db, "retro-derive", ["promote", "retro_invalidate"]);
      snapshot.shown.set(40, 2);
      snapshot.shown.set(55, 1);
      snapshot.pairs.set(40, new Set([55]));
      const applied = await applyProposals(
        { db, sleepData, memoryDir: dir, snapshot, alreadyAccepted: new Map() },
        'RETRO_INVALIDATE old_id=55 new_id=40 reason="superseded by the retro"',
      );
      expect(applied.receipts[0]!.disposition).toBe("accepted");
      const old = db.prepare("SELECT valid_to FROM extracted_memories WHERE id = 55").get() as { valid_to: string | null };
      expect(old.valid_to).not.toBeNull();
    } finally { cleanup(); db.close(); }
  });

  it("reports drops honestly: core capacity and over-budget overflow change nothing", async () => {
    const db = createDb();
    const { dir, cleanup } = makeDir();
    try {
      const sleepData = new SleepDataAccess(db, OWNER);
      for (let i = 1; i <= 100; i++) seedMemory(db, 1000 + i, `core fact ${i}`, { tier: "core" });
      seedMemory(db, 10, "promotion candidate", { revision: 1 });
      const snapshot = snapshotFor(db, "retro-derive", ["promote"]);
      snapshot.shown.set(10, 1);
      const result = await applyProposals(
        { db, sleepData, memoryDir: dir, snapshot, alreadyAccepted: new Map() },
        'PROMOTE id=10 reason="enduring preference"',
      );
      expect(result.receipts[0]!.disposition).toBe("dropped");
      expect(result.receipts[0]!.reason).toContain("capacity");
      expect(db.prepare("SELECT tier FROM extracted_memories WHERE id = 10").get()).toEqual({ tier: "general" });
    } finally { cleanup(); db.close(); }
  });

  it("declines carry the settled source so the message is handled, not silently dropped", async () => {
    const db = createDb();
    const { dir, cleanup } = makeDir();
    try {
      const sleepData = new SleepDataAccess(db, OWNER);
      const snapshot = snapshotFor(db, "extract-memories", ["store", "decline"]);
      snapshot.sources.set(7, "user said nothing durable");
      const result = await applyProposals(
        { db, sleepData, memoryDir: dir, snapshot, alreadyAccepted: new Map() },
        'DECLINE srcmsg=7 reason="small talk only"',
      );
      expect(result.receipts[0]!.disposition).toBe("declined");
      expect(result.receipts[0]!.source).toBe(7);
    } finally { cleanup(); db.close(); }
  });
});

// ── Extraction dispositions ─────────────────────────────────────────────────

function offered(id: number, content: string): OfferedMessage {
  return { id, role: "user", content, ts: 1 };
}

describe("#1859 extraction dispositions", () => {
  it("a decline-only batch is disposition-complete; a silent batch is not", async () => {
    const db = createDb();
    const { dir, cleanup } = makeDir();
    try {
      const sleepData = new SleepDataAccess(db, OWNER);
      const batch = [offered(11, "user likes tea"), offered(12, "user is tired today")];
      const declined = await applyExtractionBatch({
        db, sleepData, memoryDir: dir, runId: RUN, step: "extract-memories", principal: OWNER, batch,
        response: 'DECLINE srcmsg=11 reason="trivial"\nDECLINE srcmsg=12 reason="transient mood"',
      });
      expect(declined.unhandled).toEqual([]);
      const receipts = readReceipts(dir, RUN);
      expect(receipts.filter(r => r.disposition === "declined")).toHaveLength(2);

      const silent = await applyExtractionBatch({
        db, sleepData, memoryDir: dir, runId: `${RUN}-2`, step: "extract-memories", principal: OWNER, batch,
        response: "2 memories stored (prose only)",
      });
      expect(silent.unhandled).toEqual([11, 12]);
    } finally { cleanup(); db.close(); }
  });

  it("a store for an unoffered id does not settle the batch", async () => {
    const db = createDb();
    const { dir, cleanup } = makeDir();
    try {
      const sleepData = new SleepDataAccess(db, OWNER);
      const result = await applyExtractionBatch({
        db, sleepData, memoryDir: dir, runId: RUN, step: "extract-memories", principal: OWNER,
        batch: [offered(11, "user likes tea")],
        response: 'PROPOSE_STORE srcmsg=99 type=fact text="invented"',
      });
      expect(result.unhandled).toEqual([11]);
      expect(db.prepare("SELECT COUNT(*) AS c FROM extracted_memories").get()).toEqual({ c: 0 });
    } finally { cleanup(); db.close(); }
  });
});

// ── Knowledge files and notes budget ────────────────────────────────────────

describe("#1859 knowledge-file boundary", () => {
  it("applies an add against the shown version and rejects a stale base", async () => {
    const db = createDb();
    const { dir, cleanup } = makeDir();
    try {
      const sleepData = new SleepDataAccess(db, OWNER);
      const notesPath = join(dir, "core", "agent_notes.md");
      writeFileSync(notesPath, "Existing rule one.\n");
      const version = readKnowledgeVersion(dir, "agent_notes.md");
      if ("unavailable" in version) throw new Error("test setup: notes unreadable");
      const snapshot = snapshotFor(db, "retro-derive", ["knowledge_add", "knowledge_remove", "knowledge_update"]);
      snapshot.knowledge.set("agent_notes.md", version);
      const base = version.hash.slice(0, 12);

      const added = await applyProposals(
        { db, sleepData, memoryDir: dir, snapshot, alreadyAccepted: new Map() },
        `KNOWLEDGE_ADD file=agent_notes.md base=${base} provenance="retro 2026-04-18"\nNew persistent rule.\nEND_KNOWLEDGE`,
      );
      expect(added.receipts[0]!.disposition).toBe("accepted");
      expect(readFileSync(notesPath, "utf-8")).toContain("New persistent rule.");

      const stale = await applyProposals(
        { db, sleepData, memoryDir: dir, snapshot, alreadyAccepted: new Map() },
        `KNOWLEDGE_ADD file=agent_notes.md base=${base} provenance="retro 2026-04-18"\nStale second write.\nEND_KNOWLEDGE`,
      );
      expect(stale.receipts[0]!.disposition).toBe("rejected");
      expect(stale.receipts[0]!.reason).toContain("stale");
      expect(readFileSync(notesPath, "utf-8")).not.toContain("Stale second write.");
    } finally { cleanup(); db.close(); }
  });

  it("rejects an add whose result exceeds the 8 KiB agent_notes budget and leaves the file unchanged", async () => {
    const db = createDb();
    const { dir, cleanup } = makeDir();
    try {
      const sleepData = new SleepDataAccess(db, OWNER);
      const notesPath = join(dir, "core", "agent_notes.md");
      const nearCap = "x".repeat(AGENT_NOTES_BUDGET_BYTES - 100);
      writeFileSync(notesPath, nearCap + "\n");
      const version = readKnowledgeVersion(dir, "agent_notes.md");
      if ("unavailable" in version) throw new Error("test setup: notes unreadable");
      const snapshot = snapshotFor(db, "retro-derive", ["knowledge_add"]);
      snapshot.knowledge.set("agent_notes.md", version);
      const before = readFileSync(notesPath, "utf-8");
      const result = await applyProposals(
        { db, sleepData, memoryDir: dir, snapshot, alreadyAccepted: new Map() },
        `KNOWLEDGE_ADD file=agent_notes.md base=${version.hash.slice(0, 12)} provenance="retro"\n${"y".repeat(500)}\nEND_KNOWLEDGE`,
      );
      expect(result.receipts[0]!.disposition).toBe("rejected");
      expect(result.receipts[0]!.reason).toContain("8 KiB");
      expect(readFileSync(notesPath, "utf-8")).toBe(before);
    } finally { cleanup(); db.close(); }
  });

  it("removes/updates exactly one entry and reports an absent file explicitly", async () => {
    const db = createDb();
    const { dir, cleanup } = makeDir();
    try {
      const sleepData = new SleepDataAccess(db, OWNER);
      const notesPath = join(dir, "core", "agent_notes.md");
      writeFileSync(notesPath, "Rule one stays.\n\nRule two is outdated.\n");
      const version = readKnowledgeVersion(dir, "agent_notes.md");
      if ("unavailable" in version) throw new Error("test setup: notes unreadable");
      const snapshot = snapshotFor(db, "retro-derive", ["knowledge_add", "knowledge_remove", "knowledge_update"]);
      snapshot.knowledge.set("agent_notes.md", version);
      snapshot.knowledgeUnavailable.set("core_facts.md", "absent");
      const base = version.hash.slice(0, 12);

      const removed = await applyProposals(
        { db, sleepData, memoryDir: dir, snapshot, alreadyAccepted: new Map() },
        `KNOWLEDGE_REMOVE file=agent_notes.md base=${base} match="Rule two is outdated." provenance="retro"`,
      );
      expect(removed.receipts[0]!.disposition).toBe("accepted");
      const afterRemove = readFileSync(notesPath, "utf-8");
      expect(afterRemove).toContain("Rule one stays.");
      expect(afterRemove).not.toContain("Rule two is outdated.");

      const absent = await applyProposals(
        { db, sleepData, memoryDir: dir, snapshot, alreadyAccepted: new Map() },
        `KNOWLEDGE_ADD file=core_facts.md base=${base} provenance="retro"\nShould not apply.\nEND_KNOWLEDGE`,
      );
      expect(absent.receipts[0]!.disposition).toBe("rejected");
      expect(absent.receipts[0]!.reason).toContain("absent");
    } finally { cleanup(); db.close(); }
  });

  it("bounds the model-bound notes view at 8 KiB with a visible omission marker", () => {
    const oversized = Array.from({ length: 400 }, (_, i) => `- entry ${i} ${"z".repeat(40)}`).join("\n\n");
    const view = applyNotesReadBudget(oversized);
    expect(view.truncated).toBe(true);
    expect(view.totalBytes).toBeGreaterThan(AGENT_NOTES_BUDGET_BYTES);
    expect(Buffer.byteLength(view.text, "utf-8")).toBeLessThanOrEqual(AGENT_NOTES_BUDGET_BYTES + Buffer.byteLength(notesOmissionMarker(0), "utf-8") + 16);
    expect(view.text).toContain("omitted");
    expect(view.text).toContain("- entry 0");
    const small = applyNotesReadBudget("- short note");
    expect(small.truncated).toBe(false);
    expect(small.text).toBe("- short note");
    // The budget never rewrites the source; hashing stays stable for CAS.
    expect(hashKnowledgeBytes(oversized)).toBe(hashKnowledgeBytes(oversized));
  });
});

// ── Proposal-only enforcement ───────────────────────────────────────────────

describe("#1859 proposal-only fail-closed", () => {
  it("fails the fenced step without a model call when the runtime cannot enforce it", async () => {
    const env = await setupTestEnv({ seedMessages: 3 });
    try {
      const wrapped: SleepRuntime = {
        complete: (request) => env.runtime.complete(request),
      };
      const opts: SleepRunOptions = {
        runtime: wrapped,
        now: () => env.now,
        timeoutMs: 60_000,
        fresh: false,
        betweenStepBackoffMs: () => 0,
        memoryConfigOverride: { memoryDir: env.memoryDir, memoryEnabled: true },
      };
      const before = env.runtime.callCount();
      const result = await runSleepCycle(opts);
      expect(result.status).toBe("failed");
      expect(result.watermarkAdvanced).toBe(false);
      const extractionCalls = env.runtime.callsFor("PROPOSAL-EXTRACTION-V1");
      expect(extractionCalls, "no model call may run for an unenforceable proposal-only step").toHaveLength(0);
      // Steps before extraction may call the model; the fenced step must not.
      expect(env.runtime.callCount()).toBeGreaterThanOrEqual(before);
    } finally { env.cleanup(); }
  });
});
