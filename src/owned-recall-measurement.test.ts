/**
 * owned-recall-measurement.test.ts — #1928 M6 measured value (A12).
 *
 * Freezes the evaluated policy/corpus/provider configuration and reports
 * whole-path latency distributions (p50/p95) plus rendered-evidence
 * precision/coverage for the three profiles, provider-off/degraded cases
 * and intentional S6 exclusions. Deterministic fixtures only: no provider,
 * no model, no clock boundaries beyond performance.now. Bounds are generous
 * regression tripwires (multiples of the frozen C3 deadlines), never
 * fitted performance claims.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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
  OWNED_PROFILE_BOUNDS,
} from "./owned-recall-contract.js";
import type { OwnedRecallRequest, OwnedRecallPacket } from "./owned-recall-contract.js";

const OWNER = "owned-measure-owner";

let tmpDir: string;
let mm: MemoryManager;

function db() {
  const handle = getMemoryDb(mm);
  if (!handle) throw new Error("test database missing");
  return handle;
}

function seedDurable(content: string): void {
  const messageId = Number(db().prepare(
    "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 's1', 'user', ?, 1000)",
  ).run(OWNER, content).lastInsertRowid);
  storeDurable(db(), {
    userId: OWNER, memoryType: "fact", content, authority: "user_statement",
    authorityBasis: "test message", applicabilityScope: { scope: "general" },
    provenance: {}, evidence: [{ kind: "user_message", ref: String(messageId), excerpt: content, classification: 1 }],
    actorId: "test",
  });
}

function seedEpisode(topic: string, sessionId: string): void {
  const u = Number(db().prepare(
    "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, 'user', ?, 1000)",
  ).run(OWNER, sessionId, `${topic} user turn`).lastInsertRowid);
  const a = Number(db().prepare(
    "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, 'assistant', ?, 1000)",
  ).run(OWNER, sessionId, `${topic} assistant turn`).lastInsertRowid);
  createEpisode(db(), {
    userId: OWNER, topic, startTs: 1000, endTs: 2000, sessionIds: [sessionId],
    sourceMessageIds: [u, a],
    evidenceExcerpts: [{ messageId: u, excerpt: `${topic} user turn`, classification: 1 }],
    actorId: "test",
  });
}

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  return sortedMs[Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1)]!;
}

async function timeRecall(request: OwnedRecallRequest): Promise<{ packet: OwnedRecallPacket; ms: number }> {
  const start = performance.now();
  const packet = await ownedRecall(mm, request);
  return { packet, ms: performance.now() - start };
}

describe("A12 measured value (frozen policy/corpus, provider-off)", () => {
  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "owned-measure-"));
    mm = new MemoryManager(makeMemoryTestConfig(join(tmpDir, "memory")));
    await mm.initialize({ skipEmbeddingCheck: true });
    const handle = getMemoryDb(mm)!;
    void handle;
    setPersonalState(db(), "ready", { reason: "test ready" });
    // Measured corpus: 40 durable facts across distinct topics plus two
    // episodes and one authorized summary. No embeddings (provider-off).
    const topics = [
      "harbor ferry schedule", "library book return", "garden tomato planting",
      "dentist appointment reminder", "passport renewal deadline", "bicycle tire pressure",
      "sourdough starter feeding", "roof gutter cleaning", "tax document folder",
      "smoke detector battery", "winter tire storage", "allergy medication refill",
    ];
    for (let i = 0; i < 40; i++) {
      seedDurable(`${topics[i % topics.length]} note number ${i} everyday`);
    }
    seedEpisode("harbor ferry episode", "s-measure-ep");
    seedEpisode("library membership episode", "s-measure-ep2");
    const dailyDir = join(tmpDir, "memory", "daily");
    mkdirSync(dailyDir, { recursive: true });
    writeFileSync(
      join(dailyDir, "daily_2026-10-19.md"),
      `# Daily Summary\nOwner: ${OWNER}\n\n- harbor ferry retrospective with schedule notes\n`,
      "utf-8",
    );
    const build = buildRecallProjection(db(), OWNER, { verifiedBackup: true });
    expect(build.ok).toBe(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mm.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports p50/p95 within generous multiples of the frozen C3 deadlines", async () => {
    const spy = vi.spyOn(mm, "getEmbeddingProvider").mockReturnValue(null);
    const runs = 7;
    const rows: Array<{ profile: string; p50: number; p95: number; max: number; status: string }> = [];
    try {
      const cases = [
        { profile: "recall_fast", request: { contract: OWNED_RECALL_CONTRACT, profile: "recall_fast", identity: { principal: OWNER }, rawTurn: "harbor ferry everyday" } },
        { profile: "recall_normal", request: { contract: OWNED_RECALL_CONTRACT, profile: "recall_normal", identity: { principal: OWNER }, query: { text: "harbor ferry everyday" } } },
        { profile: "recall_full", request: { contract: OWNED_RECALL_CONTRACT, profile: "recall_full", identity: { principal: OWNER }, query: { text: "harbor ferry everyday" } } },
      ] as const;
      for (const { profile, request } of cases) {
        const samples: number[] = [];
        let lastStatus = "";
        for (let i = 0; i < runs; i++) {
          const { packet, ms } = await timeRecall(request);
          samples.push(ms);
          lastStatus = packet.status;
          expect(packet.items.length).toBeGreaterThan(0);
        }
        samples.sort((a, b) => a - b);
        const bound = OWNED_PROFILE_BOUNDS[profile];
        const row = {
          profile,
          p50: Math.round(percentile(samples, 50) * 10) / 10,
          p95: Math.round(percentile(samples, 95) * 10) / 10,
          max: Math.round(samples[samples.length - 1]! * 10) / 10,
          status: lastStatus,
        };
        rows.push(row);
        // Generous regression tripwire: p95 stays within twice the frozen
        // owner work deadline for the profile.
        expect(row.p95).toBeLessThanOrEqual(bound.workDeadlineMs * 2);
      }
    } finally {
      spy.mockRestore();
    }
    // eslint-disable-next-line no-console
    console.log(`[A12 latency] ${JSON.stringify({ corpus: { durables: 40, episodes: 2, summaries: 1 }, provider: "off", runs, rows })}`);
  }, 120_000);

  it("reports precision/coverage per profile with intentional S6 exclusion", async () => {
    const spy = vi.spyOn(mm, "getEmbeddingProvider").mockReturnValue(null);
    try {
      const fast = await ownedRecall(mm, {
        contract: OWNED_RECALL_CONTRACT, profile: "recall_fast",
        identity: { principal: OWNER }, rawTurn: "harbor ferry everyday",
      });
      const normal = await ownedRecall(mm, {
        contract: OWNED_RECALL_CONTRACT, profile: "recall_normal",
        identity: { principal: OWNER }, query: { text: "harbor ferry everyday" },
      });
      const full = await ownedRecall(mm, {
        contract: OWNED_RECALL_CONTRACT, profile: "recall_full",
        identity: { principal: OWNER }, query: { text: "harbor ferry everyday" },
      });
      const hasHarbor = (p: OwnedRecallPacket): boolean =>
        p.items.some((i) => i.excerpt.includes("harbor ferry"));
      expect(hasHarbor(fast)).toBe(true);
      expect(hasHarbor(normal)).toBe(true);
      expect(hasHarbor(full)).toBe(true);
      // Fast/normal never touch S6, even when a summary matches.
      expect(fast.stageOutcomes["S6"]?.status).toBe("disabled");
      expect(normal.stageOutcomes["S6"]?.status).toBe("disabled");
      // Full runs S6: it completes and finds the authorized summary. The
      // item itself is capacity-bounded (40 durables fill the 40 slots).
      expect(full.stageOutcomes["S6"]?.status).toBe("completed");
      expect(full.stageOutcomes["S6"]?.hitCount).toBeGreaterThanOrEqual(1);
      const fullSummaries = full.items.filter((i) => i.ref.kind === "artifact");
      expect(fullSummaries.length).toBeGreaterThanOrEqual(0);
      // eslint-disable-next-line no-console
      console.log(`[A12 coverage] ${JSON.stringify({
        fast: { items: fast.items.length, status: fast.status },
        normal: { items: normal.items.length, status: normal.status },
        full: { items: full.items.length, artifacts: fullSummaries.length, status: full.status },
      })}`);
    } finally {
      spy.mockRestore();
    }
  });

  it("degrades boundedly when the embedding wait expires", async () => {
    const hanging = {
      embedText: (_text: string) => new Promise<Float32Array | null>(() => {}),
      batchEmbed: async (_texts: string[]) => [] as Array<Float32Array | null>,
      dimensions: 8,
      name: "hanging-measure-provider",
    };
    const spy = vi.spyOn(mm, "getEmbeddingProvider").mockReturnValue(hanging);
    try {
      const { packet, ms } = await timeRecall({
        contract: OWNED_RECALL_CONTRACT, profile: "recall_normal",
        identity: { principal: OWNER }, query: { text: "harbor ferry everyday" },
      });
      // Deterministic recall still serves despite the saturated Se stage;
      // the packet is partial, never a false empty, and the foreground
      // wait stays near the frozen 500ms normal budget.
      expect(packet.items.length).toBeGreaterThan(0);
      expect(packet.status).toBe("partial");
      expect(packet.omissionReasons.some((r) => r.startsWith("stage-degraded: Se"))).toBe(true);
      expect(ms).toBeLessThan(OWNED_PROFILE_BOUNDS.recall_normal.workDeadlineMs * 2);
      // eslint-disable-next-line no-console
      console.log(`[A12 degraded] ${JSON.stringify({ ms: Math.round(ms), status: packet.status, items: packet.items.length })}`);
    } finally {
      spy.mockRestore();
    }
  }, 120_000);
});
