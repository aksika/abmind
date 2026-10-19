/**
 * owned-recall.test.ts — #1928 M1 contract and cutover admission.
 *
 * Each test protects a binding C1/C2 invariant: version admission, owner
 * authorization, complete refs, honest statuses, capacity ceilings, and
 * context bounds. Indexed stages, contextual planning, and continuation
 * paging are M3; these tests pin the M1 admission boundary only.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { buildRecallProjection } from "./recall-projection-build.js";
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
    const packet = await ownedRecall(mm, fastRequest({ rawTurn: "where does the meeting happen" }));
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
    const packet = await ownedRecall(mm, fastRequest({ rawTurn: "zirconium telescopes never mentioned" }));
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
  });
});

describe("context bounds and lifecycle", () => {
  it("rejects more than four snapshots; foreign context is rejected with reasons", async () => {
    seedDurable("the meeting happens downtown");
    build();
    const snap = (i: number) => ({ text: `prior turn ${i}`, principal: OWNER, host: "h", conversation: "c", complete: true });
    const tooMany = fastRequest({ context: [snap(1), snap(2), snap(3), snap(4), snap(5)] });
    expect(validateOwnedRecallRequest(tooMany)).toMatch(/at most 4/);
    const foreign = await ownedRecall(mm, fastRequest({
      rawTurn: "where does the meeting happen",
      context: [{ text: "prior turn", principal: INTRUDER, host: "h", conversation: "c", complete: true }],
    }));
    expect(foreign.contextRejected?.some((r) => r.includes("foreign principal"))).toBe(true);
  });

  it("returns unavailable with conversion-required when personal content is legacy", async () => {
    setPersonalState(db(), "legacy", { reason: "test legacy" });
    const packet = await ownedRecall(mm, fastRequest());
    expect(packet.status).toBe("unavailable");
    expect(packet.omissionReasons.some((r) => r.includes("conversion-required"))).toBe(true);
    expect(packet.items).toEqual([]);
  });
});
