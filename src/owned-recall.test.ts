/**
 * owned-recall.test.ts — #1928 M1 contract and cutover admission.
 *
 * Each test protects a binding C1/C2 invariant: version admission, owner
 * authorization, complete refs, honest statuses, capacity ceilings, and
 * context bounds. Indexed stages, contextual planning, and continuation
 * paging are M3; these tests pin the M1 admission boundary only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager, getMemoryDb } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { initializeDatabase } from "./memory-db.js";
import { ensureInitialized } from "./ensure-initialized.js";
import { setPersonalState } from "./personal-schema.js";
import { storeDurable } from "./personal-durable.js";
import { createEpisode } from "./personal-episodes.js";
import { buildRecallProjection, backfillRecallVectors } from "./recall-projection-build.js";
import { ownedRecall } from "./owned-recall.js";
import {
  OWNED_RECALL_CONTRACT,
  isCompleteOwnedRef,
  ownedRefKey,
  validateOwnedRecallRequest,
} from "./owned-recall-contract.js";
import type { OwnedRecallRequest } from "./owned-recall-contract.js";

const OWNER = "owned-recall-owner";
const INTRUDER = "owned-recall-intruder";

let tmpDir: string;
let mm: MemoryManager;

function db() {
  const handle = getMemoryDb(mm);
  if (!handle) throw new Error("test database missing");
  return handle;
}

function fastRequest(overrides?: Partial<OwnedRecallRequest>): OwnedRecallRequest {
  return {
    contract: OWNED_RECALL_CONTRACT,
    profile: "recall_fast",
    identity: { principal: OWNER },
    rawTurn: "where does the meeting happen",
    ...overrides,
  };
}

function insertMessage(userId: string, content: string): number {
  return Number(db().prepare(
    "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 's1', 'user', ?, 1000)",
  ).run(userId, content).lastInsertRowid);
}

function seedDurable(content: string, evidenceContent?: string): { durableId: number; messageId: number } {
  const messageId = insertMessage(OWNER, evidenceContent ?? content);
  const d = storeDurable(db(), {
    userId: OWNER, memoryType: "fact", content, authority: "user_statement",
    authorityBasis: "test message", applicabilityScope: { scope: "general" },
    provenance: {}, evidence: [{ kind: "user_message", ref: String(messageId), excerpt: evidenceContent ?? content, classification: 1 }],
    actorId: "test",
  });
  return { durableId: d.id, messageId };
}

function seedEpisode(topic: string, sessionId: string): number {
  const u = Number(db().prepare(
    "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, 'user', ?, 1000)",
  ).run(OWNER, sessionId, `${topic} user turn`).lastInsertRowid);
  const a = Number(db().prepare(
    "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, 'assistant', ?, 1000)",
  ).run(OWNER, sessionId, `${topic} assistant turn`).lastInsertRowid);
  const excerpt = `${topic} user turn`;
  const e = createEpisode(db(), {
    userId: OWNER, topic, startTs: 1000, endTs: 2000, sessionIds: [sessionId],
    sourceMessageIds: [u, a],
    evidenceExcerpts: [{ messageId: u, excerpt, classification: 1 }],
    actorId: "test",
  });
  return e.id;
}

/** The owned pipeline serves the registry, not the source tables directly. */
function build(): void {
  const outcome = buildRecallProjection(db(), OWNER, { verifiedBackup: true });
  expect(outcome.ok).toBe(true);
}

const fakeEmbed = (vector: Float32Array) => async (_text: string): Promise<Float32Array | null> => vector;
const unitVector = (dim: number, at: number): Float32Array => {
  const v = new Float32Array(dim);
  v[at % dim] = 1;
  return v;
};

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "owned-recall-"));
  mm = new MemoryManager(makeMemoryTestConfig(tmpDir), { ownerSnapshot: OWNER });
  await mm.initialize({ skipEmbeddingCheck: true });
  const handle = getMemoryDb(mm);
  if (!handle) throw new Error("test database missing");
  ensureInitialized(handle, tmpDir);
  setPersonalState(handle, "ready", { reason: "owned recall test ready" });
});

afterEach(() => {
  mm.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("C1 contract admission", () => {
  it("rejects a missing contract before searching", () => {
    expect(validateOwnedRecallRequest({ ...fastRequest(), contract: undefined })).toMatch(/contract/);
  });

  it("rejects an unknown contract without retrying an old operation", () => {
    expect(validateOwnedRecallRequest({ ...fastRequest(), contract: "legacy-v0" })).toMatch(/owned-v1/);
  });

  it("requires a profile; there is no inferred or unprofiled mode", () => {
    expect(validateOwnedRecallRequest({ ...fastRequest(), profile: undefined })).toMatch(/profile/);
  });

  it("fast without a verbatim turn is invalid; normal without an anchor is invalid", () => {
    expect(validateOwnedRecallRequest(fastRequest({ rawTurn: "  " }))).toMatch(/rawTurn/);
    const normal = fastRequest({ profile: "recall_normal", query: { text: "  ", keywords: [] } });
    expect(validateOwnedRecallRequest({ ...normal, rawTurn: undefined })).toMatch(/query/);
  });

  it("rejects capacity above the profile ceiling and legacy policy knobs", async () => {
    const over = fastRequest({ capacity: { maxItems: 6 } });
    expect(validateOwnedRecallRequest(over)).toMatch(/maxItems/);
    const legacy = fastRequest({ filters: { minScore: 0.7 } as never });
    expect(validateOwnedRecallRequest(legacy)).toMatch(/minScore/);
    await expect(ownedRecall(mm, over)).rejects.toThrow(/maxItems/);
  });

  it("exposes owned-v1 in the negotiated feature snapshot", async () => {
    const { dispatchNegotiate } = await import("./abmind-ops-dispatch.js");
    const caps = dispatchNegotiate(undefined, {
      mode: "embedded", serverInstanceId: "test", operationalAvailable: false,
      memoryEnabled: true, buildCommit: null, releaseId: null, startTime: Date.now(), requestCount: 0,
    });
    expect(caps.features["personal_recall_contract"]).toBe("owned-v1");
  });
});

describe("C2 identity and authorization", () => {
  it("refuses a foreign principal against the startup snapshot", async () => {
    seedDurable("the meeting happens downtown");
    await expect(ownedRecall(mm, fastRequest({
      identity: { principal: INTRUDER },
      rawTurn: "where does the meeting happen",
    }))).rejects.toThrow(/unauthorized/);
  });

  it("refuses payload identity that does not match the transport", async () => {
    await expect(ownedRecall(mm, fastRequest(), { transportPrincipal: INTRUDER })).rejects.toThrow(/transport/);
  });

  it("serves primary-owned inference with actual attribution while foreign raw stays unavailable", async () => {
    // Pre-doctrine legacy row: cites a foreign-owner message. The reviewed
    // writer refuses this shape today; the row simulates converted data
    // that predates the single-master doctrine (#1930 deviations).
    const foreignMsg = insertMessage(INTRUDER, "intruder secret plan");
    const now = Date.now();
    const legacyId = Number(db().prepare(
      `INSERT INTO long_term_memories
        (user_id, memory_type, content, authority, applicability_scope, evidence, classification, encrypted, created_at, updated_at)
       VALUES (?, 'fact', ?, 'inference', '{"scope":"general"}', ?, 1, 0, ?, ?)`,
    ).run(OWNER, "reowned worker note about planning",
      JSON.stringify([{ kind: "user_message", ref: String(foreignMsg), excerpt: "intruder secret plan", classification: 1 }]),
      now, now).lastInsertRowid);
    build();
    const packet = await ownedRecall(mm, {
      contract: OWNED_RECALL_CONTRACT,
      profile: "recall_full",
      identity: { principal: OWNER },
      query: { text: "worker note about planning" },
    });
    const served = packet.items.find((i) => i.ref.kind === "db" && i.ref.layer === "durable" && i.ref.recordId === legacyId);
    expect(served?.authority).toBe("inference");
    expect(packet.items.some((i) => i.ref.kind === "db" && i.ref.layer === "raw" && (i.ref as { recordId: number }).recordId === foreignMsg)).toBe(false);
    expect(packet.omissionReasons.some((r) => r.includes("foreign owner"))).toBe(true);
  });
});

describe("C2 refs and packet accounting", () => {
  it("returns complete refs, text citations, and effective limits", async () => {
    const { durableId } = seedDurable("the meeting happens downtown");
    build();
    // Provider-off composition: no optional Se stage, so nothing degrades.
    const spy = vi.spyOn(mm, "getEmbeddingProvider").mockReturnValue(null);
    let packet: Awaited<ReturnType<typeof ownedRecall>>;
    try {
      packet = await ownedRecall(mm, fastRequest({ rawTurn: "where does the meeting happen" }));
    } finally {
      spy.mockRestore();
    }
    expect(packet.contract).toBe(OWNED_RECALL_CONTRACT);
    expect(packet.status).toBe("evidence");
    expect(packet.items.length).toBeGreaterThan(0);
    for (const item of packet.items) {
      expect(isCompleteOwnedRef(item.ref)).toBe(true);
      expect(packet.text).toContain(ownedRefKey(item.ref));
      expect(packet.text).toContain(item.excerpt);
    }
    const ref = packet.items[0]?.ref;
    if (ref?.kind === "db") {
      expect(ref.layer).toBe("durable");
      expect(ref.recordId).toBe(durableId);
      expect(ref.owner).toBe(OWNER);
      expect(ref.version.length).toBeGreaterThan(0);
    } else {
      throw new Error("expected a durable db ref");
    }
    expect(packet.effective.maxOutputBytes).toBe(2000);
    expect(packet.effective.maxItems).toBe(5);
    expect(packet.stageOutcomes.Sf?.status).toBe("completed");
  });

  it("keeps same-numbered durable and episode evidence distinct", async () => {
    const { durableId } = seedDurable("the harbor ferry departs at nine");
    const episodeId = seedEpisode("harbor ferry schedule", "s2");
    expect(durableId).toBe(1);
    expect(episodeId).toBe(1);
    build();
    const packet = await ownedRecall(mm, {
      contract: OWNED_RECALL_CONTRACT,
      profile: "recall_full",
      identity: { principal: OWNER },
      query: { text: "harbor ferry departs nine" },
    });
    const keys = packet.items.map((i) => ownedRefKey(i.ref));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.some((k) => k.startsWith(`db:durable:${durableId}:`))).toBe(true);
    expect(keys.some((k) => k.startsWith(`db:episode:${episodeId}:`))).toBe(true);
  });

  it("reports empty only on successful requested coverage", async () => {
    build();
    const spy = vi.spyOn(mm, "getEmbeddingProvider").mockReturnValue(null);
    let packet: Awaited<ReturnType<typeof ownedRecall>>;
    try {
      packet = await ownedRecall(mm, fastRequest({ rawTurn: "zirconium telescopes never mentioned" }));
    } finally {
      spy.mockRestore();
    }
    expect(packet.status).toBe("empty");
    expect(packet.items).toEqual([]);
  });
});

describe("profiles and skip", () => {
  it("fast may skip a fully measured uninformative turn; normal searches the same anchor", async () => {
    for (let i = 0; i < 6; i++) seedDurable(`commonplace filler note number ${i} everyday`);
    build();
    const skipped = await ownedRecall(mm, fastRequest({ rawTurn: "everyday" }));
    expect(skipped.status).toBe("skipped");
    const searched = await ownedRecall(mm, {
      contract: OWNED_RECALL_CONTRACT,
      profile: "recall_normal",
      identity: { principal: OWNER },
      query: { text: "everyday" },
    });
    expect(searched.status).not.toBe("skipped");
    // A usable informative context term defeats the combined skip rule.
    const withContext = await ownedRecall(mm, fastRequest({
      identity: { principal: OWNER, host: "h", conversation: "c" },
      rawTurn: "everyday",
      context: [{ text: "zirconium telescope calibration", principal: OWNER, host: "h", conversation: "c", execution: "exec-prior", complete: true }],
    }));
    expect(withContext.status).not.toBe("skipped");
  });
});

describe("context bounds and lifecycle", () => {
  it("renders exactly the selected excerpt when an item exceeds the text budget", async () => {
    const long = `the meeting happens downtown ${"and the ferry schedule stays fixed ".repeat(20)}`;
    const { durableId } = seedDurable(long);
    build();
    const spy = vi.spyOn(mm, "getEmbeddingProvider").mockReturnValue(null);
    let packet: Awaited<ReturnType<typeof ownedRecall>>;
    try {
      packet = await ownedRecall(mm, fastRequest({
        rawTurn: "where does the meeting happen",
        capacity: { maxOutputBytes: 120 },
      }));
    } finally {
      spy.mockRestore();
    }
    expect(packet.items.length).toBe(1);
    const item = packet.items[0]!;
    expect(Buffer.byteLength(packet.text, "utf-8")).toBeLessThanOrEqual(120);
    expect(packet.text).toContain(item.excerpt);
    expect(item.excerptProvenance).toContain("truncated owner-side");
    expect(item.ref.kind === "db" && item.ref.recordId === durableId).toBe(true);
    expect(packet.truncation?.omittedCount).toBe(0);
  });
  it("rejects more than four snapshots; foreign context is rejected with reasons", async () => {
    seedDurable("the meeting happens downtown");
    build();
    const snap = (i: number) => ({ text: `prior turn ${i}`, principal: OWNER, host: "h", conversation: "c", complete: true });
    const tooMany = fastRequest({ context: [snap(1), snap(2), snap(3), snap(4), snap(5)] });
    expect(validateOwnedRecallRequest(tooMany)).toMatch(/at most 4/);
    const foreign = await ownedRecall(mm, fastRequest({
      identity: { principal: OWNER, host: "h", conversation: "c" },
      rawTurn: "where does the meeting happen",
      context: [{ text: "prior turn", principal: INTRUDER, host: "h", conversation: "c", execution: "exec-prior", complete: true }],
    }));
    expect(foreign.contextRejected?.some((r) => r.includes("foreign principal"))).toBe(true);
  });

  it("continues accumulating pages without repeating an earlier page", async () => {
    for (let i = 0; i < 3; i++) seedDurable(`harbor ferry pageable note ${i} everyday`);
    build();
    const request = {
      contract: OWNED_RECALL_CONTRACT,
      profile: "recall_normal" as const,
      identity: { principal: OWNER },
      query: { text: "harbor ferry pageable everyday" },
      capacity: { maxItems: 1 },
    };
    const first = await ownedRecall(mm, request);
    expect(first.items).toHaveLength(1);
    const second = await ownedRecall(mm, { ...request, continuation: first.continuation });
    expect(second.items).toHaveLength(1);
    const third = await ownedRecall(mm, { ...request, continuation: second.continuation });
    expect(third.items).toHaveLength(1);
    const keys = [first, second, third].flatMap((p) => p.items.map((i) => JSON.stringify(i.ref)));
    expect(new Set(keys).size).toBe(3);
    // A fourth page has nothing left; the accumulated handle still guards
    // against repetition if the corpus later grows within the same lookup.
    const fourth = await ownedRecall(mm, { ...request, continuation: third.continuation });
    expect(fourth.items).toHaveLength(0);
  });

  it("keeps fast durable-only even when episode vectors exist", async () => {    seedDurable("harbor ferry durable fact");
    seedEpisode("harbor ferry episode", "s-fast-ep");
    build();
    // Same query vector as every document: without the profile layer gate,
    // Se would admit the episode into a fast packet.
    const filled = await backfillRecallVectors(db(), OWNER, fakeEmbed(unitVector(8, 2)));
    expect(filled.computed).toBe(2);
    const fast = await ownedRecall(mm, {
      contract: OWNED_RECALL_CONTRACT,
      profile: "recall_fast",
      identity: { principal: OWNER },
      rawTurn: "harbor ferry",
      capacity: { maxItems: 5 },
    }, { skipAllowed: false });
    expect(fast.items.length).toBeGreaterThan(0);
    expect(fast.items.every((i) => i.ref.kind === "graph" || (i.ref.kind === "db" && i.ref.layer === "durable"))).toBe(true);
    const normal = await ownedRecall(mm, {
      contract: OWNED_RECALL_CONTRACT,
      profile: "recall_normal",
      identity: { principal: OWNER },
      query: { text: "harbor ferry" },
    }, { skipAllowed: false });
    expect(normal.items.some((i) => i.ref.kind === "db" && i.ref.layer === "episode")).toBe(true);
  });

  it("rejects stale-generation and current-execution context with reasons", async () => {
    seedDurable("the meeting happens downtown");
    build();
    const base = { text: "prior turn", principal: OWNER, host: "h", conversation: "c", execution: "exec-prior", complete: true };
    const stale = await ownedRecall(mm, fastRequest({
      identity: { principal: OWNER, host: "h", conversation: "c", generation: 2 },
      rawTurn: "where does the meeting happen",
      context: [{ ...base, generation: 1 }],
    }));
    expect(stale.contextRejected?.some((r) => r.includes("stale generation"))).toBe(true);
    const currentExec = await ownedRecall(mm, fastRequest({
      identity: { principal: OWNER, host: "h", conversation: "c", execution: "exec-now" },
      rawTurn: "where does the meeting happen",
      context: [{ ...base, generation: 0, execution: "exec-now" }],
    }));
    expect(currentExec.contextRejected?.some((r) => r.includes("current execution"))).toBe(true);
  });

  it("binds context to host, conversation and a prior execution", async () => {
    seedDurable("the meeting happens downtown");
    build();
    const snap = (over: Record<string, unknown> = {}) => ({
      text: "prior turn", principal: OWNER, host: "h", conversation: "c",
      execution: "exec-prior", generation: 0, complete: true, ...over,
    });
    const run = (identity: Record<string, unknown>, context: unknown[]) => ownedRecall(mm, fastRequest({
      identity: { principal: OWNER, ...identity },
      rawTurn: "where does the meeting happen",
      context: context as never,
    }));

    // No host/conversation on the request: the snapshot cannot be verified.
    const unverifiable = await run({}, [snap()]);
    expect(unverifiable.contextRejected?.join(" ")).toContain("unverifiable identity");

    const foreignHost = await run({ host: "other", conversation: "c" }, [snap()]);
    expect(foreignHost.contextRejected?.join(" ")).toContain("foreign host");

    const foreignConversation = await run({ host: "h", conversation: "other" }, [snap()]);
    expect(foreignConversation.contextRejected?.join(" ")).toContain("foreign conversation");

    const missingExecution = await run({ host: "h", conversation: "c" }, [snap({ execution: undefined })]);
    expect(missingExecution.contextRejected?.join(" ")).toContain("missing execution");

    // Verified prior-turn evidence is accepted and the packet echoes the
    // request binding so a host can drop a late packet after a reset.
    const accepted = await run({ host: "h", conversation: "c", generation: 3, execution: "exec-now" }, [snap({ generation: 3 })]);
    expect(accepted.contextRejected ?? []).toHaveLength(0);
    expect(accepted.generation).toBe(3);
    expect(accepted.host).toBe("h");
    expect(accepted.conversation).toBe("c");
    expect(accepted.execution).toBe("exec-now");
  });

  it("invalidates continuation when the session generation changes", async () => {
    for (let i = 0; i < 3; i++) seedDurable(`generation continuation note ${i} harbor`);
    build();
    const identity = { principal: OWNER, host: "h", conversation: "c", generation: 0 };
    const request: OwnedRecallRequest = {
      contract: OWNED_RECALL_CONTRACT,
      profile: "recall_normal",
      identity,
      query: { text: "generation continuation harbor" },
      capacity: { maxItems: 1 },
    };
    const first = await ownedRecall(mm, request);
    expect(first.continuation).toBeDefined();
    // Same identity pages normally.
    const second = await ownedRecall(mm, { ...request, continuation: first.continuation });
    expect(second.omissionReasons.some((r) => r.includes("continuation_invalid"))).toBe(false);

    // A reset/rewind (generation bump) invalidates the handle: fresh search
    // with a truthful reason instead of a silently widened lookup.
    const afterReset = await ownedRecall(mm, {
      ...request,
      identity: { ...identity, generation: 1 },
      continuation: first.continuation,
    });
    expect(afterReset.omissionReasons.some((r) => r.includes("continuation_invalid_identity"))).toBe(true);
    expect(afterReset.items.length).toBeGreaterThan(0);

    // A different host or conversation is equally invalid.
    const otherHost = await ownedRecall(mm, {
      ...request,
      identity: { ...identity, host: "other" },
      continuation: first.continuation,
    });
    expect(otherHost.omissionReasons.some((r) => r.includes("continuation_invalid_identity"))).toBe(true);
  });

  it("blocks recall while a forget cleanup remains pending", async () => {
    seedDurable("the meeting happens downtown");
    build();
    db().prepare(
      "INSERT INTO forget_operations (id, owner, state, targets, created_at) VALUES ('op-pending', ?, 'pending', '[]', ?)",
    ).run(OWNER, Date.now());
    const packet = await ownedRecall(mm, fastRequest({ rawTurn: "where does the meeting happen" }));
    expect(packet.status).toBe("unavailable");
    expect(packet.omissionReasons.some((r) => r.includes("forget-barrier-pending"))).toBe(true);
    expect(packet.items).toEqual([]);
  });

  it("returns unavailable with conversion-required when personal content is legacy", async () => {
    setPersonalState(db(), "legacy", { reason: "test legacy" });
    const packet = await ownedRecall(mm, fastRequest());
    expect(packet.status).toBe("unavailable");
    expect(packet.omissionReasons.some((r) => r.includes("conversion-required"))).toBe(true);
    expect(packet.items).toEqual([]);
  });
});
