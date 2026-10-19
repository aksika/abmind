import { AbmindClientError } from "abmind";
import type { AbmindClient } from "abmind";
import { OWNED_RECALL_CONTRACT } from "abmind";
import type { OwnedRecallPacket } from "abmind";
import type { AcceptanceFixture, ScenarioResult } from "./contracts.js";
import { pass, fail } from "./scenario-helpers.js";

const USER_A = "e2e-user-a";
const USER_B = "e2e-user-b";

type ScenarioFn = (fixture: AcceptanceFixture, runId: string) => Promise<ScenarioResult>;

/**
 * #1928 M4 — maintained acceptance routes recall through the owned
 * contract: explicit normal profile over the verbatim anchor, capacity
 * bounded, refs resolved by (layer, recordId, owner, version).
 */
async function recallOwned(client: AbmindClient, userId: string, text: string): Promise<OwnedRecallPacket> {
  return client.privateMemory.recall({
    contract: OWNED_RECALL_CONTRACT,
    profile: "recall_normal",
    identity: { principal: userId },
    query: { text },
    capacity: { maxItems: 10 },
  });
}

function findDbItem(packet: OwnedRecallPacket, memoryId: number): OwnedRecallPacket["items"][number] | undefined {
  return packet.items.find((i) => i.ref.kind === "db" && i.ref.recordId === memoryId);
}

/**
 * #1659: settle a semantic mutation that now rejects via AbmindClientError
 * into the data shape acceptance scenarios assert on.
 */
async function settled<T>(promise: Promise<T>): Promise<T | { ok: false; code: string; message?: string; current?: unknown }> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof AbmindClientError) {
      return { ok: false, code: err.code, message: err.message, current: err.current };
    }
    throw err;
  }
}

/**
 * #1382 bounded route-loss/recovery journey. The owner restarts on the same
 * endpoint; the signed-WSS client observes the drop, admission fails closed,
 * reconnect re-authenticates and renegotiates, and a mutation issued after
 * recovery commits exactly once (idempotency key survives the outage). The
 * local Unix lane keeps its existing behavior (in-flight calls replay across
 * the reconnect) and only asserts recovery + idempotent redelivery.
 */
const routeLossRecovery: ScenarioFn = async (fixture, runId) => {
  const start = Date.now();
  const requestIds: string[] = [];
  const client = await fixture.createClient();
  try {
    if (client.routeSnapshot.state !== "ready") {
      return fail("Route loss and recovery", Date.now() - start, requestIds, {
        stage: "ready", code: "not_ready",
        message: `Route snapshot not ready before restart: ${client.routeSnapshot.state}`,
      });
    }

    await fixture.restartOwner();

    // Fail-closed admission is a signed-WSS contract; the local lane keeps
    // its existing in-flight replay behavior and skips this assertion.
    if (fixture.transport === "remote-wss") {
      let denied = false;
      let deniedCode = "";
      try {
        await client.callRaw("system.health", {});
      } catch (err) {
        denied = true;
        deniedCode = (err as Error & { code?: string }).code ?? "";
      }
      if (!denied) {
        return fail("Route loss and recovery", Date.now() - start, requestIds, {
          stage: "fail_closed", code: "admitted",
          message: "A call was admitted while the route was down",
        });
      }
      if (deniedCode !== "unavailable" && deniedCode !== "outcome_unknown") {
        return fail("Route loss and recovery", Date.now() - start, requestIds, {
          stage: "fail_closed", code: "wrong_error",
          message: `Expected unavailable/outcome_unknown, got ${deniedCode}`,
        });
      }
    }

    // Wait for recovery: a real call must succeed again (the WSS lane also
    // requires the route snapshot to return to ready).
    const recoverDeadline = Date.now() + 35_000;
    let recovered = false;
    while (Date.now() < recoverDeadline) {
      if (fixture.transport === "remote-wss" && client.routeSnapshot.state !== "ready") {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      try {
        await client.callRaw("system.health", {});
        recovered = true;
        break;
      } catch { /* still down */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!recovered) {
      return fail("Route loss and recovery", Date.now() - start, requestIds, {
        stage: "recovery", code: "not_recovered",
        message: `Route did not recover: ${client.routeSnapshot.state}`,
      });
    }

    // Idempotent redelivery: the same key after the outage must commit one
    // memory, and a second store with the same key must not duplicate it.
    const content = `Route-loss probe ${runId}`;
    const key = `${runId}-route-loss`;
    const first = await client.privateMemory.instantStore({
      userId: USER_A, contentEn: content, contentOriginal: content,
      memoryType: "fact", emotionScore: 0.5, confidence: 5, classification: 1,
    }, key);
    if (!first.stored) {
      return fail("Route loss and recovery", Date.now() - start, requestIds, {
        stage: "redelivery", code: "store_failed",
        message: `Store after recovery failed: ${JSON.stringify(first)}`,
      });
    }
    const second = await client.privateMemory.instantStore({
      userId: USER_A, contentEn: content, contentOriginal: content,
      memoryType: "fact", emotionScore: 0.5, confidence: 5, classification: 1,
    }, key);
    if (!second.stored) {
      return fail("Route loss and recovery", Date.now() - start, requestIds, {
        stage: "redelivery", code: "store_failed",
        message: `Store after redelivery failed: ${JSON.stringify(second)}`,
      });
    }
    if (second.memoryId !== first.memoryId) {
      return fail("Route loss and recovery", Date.now() - start, requestIds, {
        stage: "redelivery", code: "idempotency_violated",
        message: `Same key produced memoryId ${first.memoryId} then ${second.memoryId}`,
      });
    }

    const recall = await recallOwned(client, USER_A, content);
    const matches = recall.items.filter((item) => item.excerpt.includes(content));
    if (matches.length !== 1) {
      return fail("Route loss and recovery", Date.now() - start, requestIds, {
        stage: "redelivery", code: "side_effects",
        message: `Expected exactly one committed memory, found ${matches.length}`,
      });
    }

    return pass("Route loss and recovery", Date.now() - start, requestIds);
  } finally {
    await client.close();
  }
};

/**
 * #1928 M6 — operator projection activation through the reviewed surface:
 * verified backup gate, generation barrier, and authenticated status
 * distinguishing the serving generation before any recall attempt.
 */
const projectionActivation: ScenarioFn = async (fixture, runId) => {
  const start = Date.now();
  const requestIds: string[] = [];
  const client = await fixture.createClient();
  try {
    const before = await client.privateMemory.getRuntimeStatus({});
    requestIds.push(`status-before`);
    const personal = (before as Record<string, unknown> | null)?.["personal"] as
      { state?: string } | undefined;
    if (personal?.state !== "ready") {
      return fail("Projection activation", Date.now() - start, requestIds, {
        stage: "personal-state", code: "not_ready",
        message: `Personal content not ready: ${JSON.stringify(personal)}`,
      });
    }
    await fixture.activateProjection();
    requestIds.push(`activate`);
    await client.close();
    const afterClient = await fixture.createClient();
    try {
      const after = await afterClient.privateMemory.getRuntimeStatus({});
      const projection = (after as Record<string, unknown> | null)?.["projection"] as
        { state?: string; servingGeneration?: number | null } | undefined;
      if (projection?.state !== "ready" || typeof projection.servingGeneration !== "number") {
        return fail("Projection activation", Date.now() - start, requestIds, {
          stage: "projection-state", code: "not_ready",
          message: `Projection not serving: ${JSON.stringify(projection)}`,
        });
      }
      return pass("Projection activation", Date.now() - start, requestIds);
    } finally {
      await afterClient.close();
    }
  } catch (err) {
    return fail("Projection activation", Date.now() - start, requestIds, {
      stage: "activate", code: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await client.close();
  }
};

// ISO 8601 constant for validTo tests
const FUTURE_DATE = "2099-12-31";

const LIVE_CAPABILITY_METHODS = [
  "private.instantStore",
  "private.recall",
  "private.recordMessage",
  "private.getRuntimeStatus",
  "private.getCoreKnowledge",
  "private.recordFeedback",
  "private.embed",
  "private.getRecentConversation",
  "private.assembleSessionContext",
  "private.dreamQuestions.nextPending",
  "private.dreamQuestions.list",
  "private.dreamQuestions.markAsked",
  "private.dreamQuestions.dismiss",
];

export const lifecycleCapabilities: ScenarioFn = async (fixture) => {
  const start = Date.now();
  const client = await fixture.createClient();

  try {
    const caps = client.capabilities;
    const requestIds: string[] = [];

    if (!caps) {
      return fail("Lifecycle and capabilities", Date.now() - start, [], {
        stage: "negotiate", code: "missing_capabilities", message: "Capabilities are null after negotiate",
      });
    }

    if (caps.version !== 1) {
      return fail("Lifecycle and capabilities", Date.now() - start, [], {
        stage: "version", code: "unexpected_version", message: `Expected version 1, got ${caps.version}`,
      });
    }

    if (caps.features?.private_read !== "true") {
      return fail("Lifecycle and capabilities", Date.now() - start, [], {
        stage: "features", code: "missing_private_read", message: "private_read is not enabled",
      });
    }
    if (caps.features?.private_write !== "true") {
      return fail("Lifecycle and capabilities", Date.now() - start, [], {
        stage: "features", code: "missing_private_write", message: "private_write is not enabled",
      });
    }
    if (caps.features?.private_mutation_contract !== "revision-v1") {
      return fail("Lifecycle and capabilities", Date.now() - start, [], {
        stage: "features", code: "wrong_mutation_contract",
        message: `Expected revision-v1, got ${caps.features?.private_mutation_contract}`,
      });
    }

    const missing: string[] = [];
    for (const method of LIVE_CAPABILITY_METHODS) {
      if (!caps.methods.includes(method)) missing.push(method);
    }
    if (missing.length > 0) {
      return fail("Lifecycle and capabilities", Date.now() - start, [], {
        stage: "methods", code: "missing_methods", message: `Missing methods: ${missing.join(", ")}`,
      });
    }

    return pass("Lifecycle and capabilities", Date.now() - start, requestIds);
  } finally {
    await client.close();
  }
};

export const storeAndRecall: ScenarioFn = async (fixture, runId) => {
  const start = Date.now();
  const requestIds: string[] = [];
  const client = await fixture.createClient(USER_A);

  try {
    const tokenA = `${runId}-fact-a`;
    const tokenB = `${runId}-fact-b`;

    const storeA = await client.privateMemory.instantStore({
      userId: USER_A,
      contentEn: "The capital of France is Paris",
      contentOriginal: "The capital of France is Paris",
      memoryType: "fact",
      emotionScore: 0.5,
      keyword: tokenA,
      createdBy: "e2e-test",
    }, tokenA);

    if (!storeA.stored || !storeA.memoryId || !storeA.semanticRevision) {
      return fail("Store and recall", Date.now() - start, requestIds, {
        stage: "store-A", code: "store_failed", message: JSON.stringify(storeA),
      });
    }
    requestIds.push(`instantStore-A`);

    await client.privateMemory.instantStore({
      userId: USER_A,
      contentEn: "The speed of light is 299792458 m/s",
      contentOriginal: "The speed of light is 299792458 m/s",
      memoryType: "fact",
      emotionScore: 0.3,
      keyword: tokenB,
      createdBy: "e2e-test",
    }, tokenB);
    requestIds.push(`instantStore-B`);

    const recallResult = await recallOwned(client, USER_A, "The capital of France is Paris");
    requestIds.push(`recall-A`);

    const found = findDbItem(recallResult, storeA.memoryId);
    if (!found) {
      return fail("Store and recall", Date.now() - start, requestIds, {
        stage: "recall-verify", code: "not_found", message: `Memory ${storeA.memoryId} not found in recall results`,
      });
    }

    if (found.ref.kind !== "db" || found.ref.version !== String(storeA.semanticRevision)) {
      return fail("Store and recall", Date.now() - start, requestIds, {
        stage: "recall-revision", code: "revision_mismatch",
        message: `Expected revision ${storeA.semanticRevision}, got ${found.ref.kind === "db" ? found.ref.version : found.ref.kind}`,
      });
    }

    return pass("Store and recall", Date.now() - start, requestIds);
  } finally {
    await client.close();
  }
};

export const semanticMutationChain: ScenarioFn = async (fixture, runId) => {
  const start = Date.now();
  const requestIds: string[] = [];
  const client = await fixture.createClient(USER_A);

  try {
    const token = `${runId}-chain`;

    const msg = await client.privateMemory.recordMessage({
      userId: USER_A, sessionId: `${runId}-chain`, role: "user",
      content: `chain source ${token}`, timestamp: Date.now(),
    }, `${runId}-chain-msg`);
    if (msg.id == null) {
      return fail("Semantic mutation chain", Date.now() - start, requestIds, {
        stage: "record", code: "record_failed", message: JSON.stringify(msg),
      });
    }
    requestIds.push(`record`);

    const store = await client.privateMemory.instantStore({
      userId: USER_A,
      contentEn: "Initial content for mutation chain",
      contentOriginal: "Initial content for mutation chain",
      memoryType: "fact",
      emotionScore: 0.5,
      keyword: token,
      sourceMessageIds: String(msg.id),
      createdBy: "e2e-test",
    }, token);

    if (!store.stored || !store.memoryId || !store.semanticRevision) {
      return fail("Semantic mutation chain", Date.now() - start, requestIds, {
        stage: "store", code: "store_failed", message: JSON.stringify(store),
      });
    }
    requestIds.push(`store`);
    const memId = store.memoryId;
    const rev = store.semanticRevision;

    // Owner correction through the reviewed operator surface: revision-safe
    // supersession with real owner source evidence.
    const corrected = await fixture.personalCli([
      "--action", "correct",
      "--durable-id", String(memId),
      "--expected-revision", String(rev),
      "--content", "Corrected content for mutation chain",
      "--authority", "user_statement",
      "--authority-basis", "chain correction",
      "--scope", '{"scope":"general"}',
      "--evidence-message-ids", String(msg.id),
    ]);
    requestIds.push(`correct`);
    const correctedRef = (corrected["result"] as Record<string, unknown> | undefined);
    const correctedRev = correctedRef?.["revision"] as number | undefined;
    if (corrected["ok"] !== true || correctedRev !== rev + 1) {
      return fail("Semantic mutation chain", Date.now() - start, requestIds, {
        stage: "correct", code: "correct_failed", message: JSON.stringify(corrected),
      });
    }

    const recallAfter = await recallOwned(client, USER_A, "mutation chain");
    requestIds.push(`recall-after`);
    const current = findDbItem(recallAfter, memId);
    if (!current || current.ref.kind !== "db" || current.ref.version !== String(rev + 1) || !current.excerpt.includes("Corrected content")) {
      return fail("Semantic mutation chain", Date.now() - start, requestIds, {
        stage: "recall-verify", code: "correction_not_served",
        message: `Corrected revision not served: ${JSON.stringify(current?.ref ?? null)}`,
      });
    }
    if (recallAfter.items.some((i) => i.ref.kind === "db" && i.ref.recordId === memId && i.excerpt.includes("Initial content"))) {
      return fail("Semantic mutation chain", Date.now() - start, requestIds, {
        stage: "recall-verify", code: "superseded_visible",
        message: "Superseded revision still served",
      });
    }

    // Stale correction conflicts against the current revision.
    const stale = await fixture.personalCli([
      "--action", "correct",
      "--durable-id", String(memId),
      "--expected-revision", String(rev),
      "--content", "Stale correction attempt",
      "--authority", "user_statement",
      "--authority-basis", "stale",
      "--scope", '{"scope":"general"}',
      "--evidence-message-ids", String(msg.id),
    ]);
    requestIds.push(`stale-correct`);
    if (stale["ok"] !== false || !JSON.stringify(stale).includes("conflict") && !JSON.stringify(stale).includes("revision")) {
      return fail("Semantic mutation chain", Date.now() - start, requestIds, {
        stage: "stale-correct", code: "conflict_missing",
        message: `Expected a revision conflict, got ${JSON.stringify(stale)}`,
      });
    }

    return pass("Semantic mutation chain", Date.now() - start, requestIds);
  } finally {
    await client.close();
  }
};

export const twoClientStaleRace: ScenarioFn = async (fixture, runId) => {
  const start = Date.now();
  const requestIds: string[] = [];
  const clientA = await fixture.createClient(USER_A);
  const clientB = await fixture.createClient(USER_A);

  try {
    const token = `${runId}-race`;

    const msg = await clientA.privateMemory.recordMessage({
      userId: USER_A, sessionId: `${runId}-race`, role: "user",
      content: `race source ${token}`, timestamp: Date.now(),
    }, `${token}-msg`);
    if (msg.id == null) {
      return fail("Two-client stale race", Date.now() - start, requestIds, {
        stage: "record", code: "record_failed", message: JSON.stringify(msg),
      });
    }
    requestIds.push(`record`);

    const store = await clientA.privateMemory.instantStore({
      userId: USER_A,
      contentEn: "Race condition test memory",
      contentOriginal: "Race condition test memory",
      memoryType: "fact",
      emotionScore: 0.5,
      keyword: token,
      sourceMessageIds: String(msg.id),
      createdBy: "e2e-test",
    }, token);

    if (!store.stored || !store.memoryId || !store.semanticRevision) {
      return fail("Two-client stale race", Date.now() - start, requestIds, {
        stage: "store", code: "store_failed", message: JSON.stringify(store),
      });
    }
    requestIds.push(`store`);

    const rev = store.semanticRevision;
    const memId = store.memoryId;
    const correctArgs = (expectedRevision: number, content: string): readonly string[] => [
      "--action", "correct",
      "--durable-id", String(memId),
      "--expected-revision", String(expectedRevision),
      "--content", content,
      "--authority", "user_statement",
      "--authority-basis", "race",
      "--scope", '{"scope":"general"}',
      "--evidence-message-ids", String(msg.id),
    ];

    // Two owners race the same revision through the operator surface: the
    // first correction wins, the second conflicts against the new current.
    const [resultA, resultB] = await Promise.all([
      fixture.personalCli(correctArgs(rev, "Correction from client A")),
      fixture.personalCli(correctArgs(rev, "Correction from client B")),
    ]);
    requestIds.push(`correct-A`, `correct-B`);

    const successes = [resultA, resultB].filter((r) => r["ok"] === true).length;
    const conflicts = [resultA, resultB].filter((r) => {
      const text = JSON.stringify(r);
      return r["ok"] === false && (text.includes("revision conflict") || text.includes("revision race"));
    }).length;

    if (successes !== 1 || conflicts !== 1) {
      return fail("Two-client stale race", Date.now() - start, requestIds, {
        stage: "race", code: "unexpected_outcome",
        message: `Expected 1 success + 1 conflict, got ${successes} success + ${conflicts} conflict. ` +
          `A=${JSON.stringify(resultA)} B=${JSON.stringify(resultB)}`,
      });
    }

    const recallAfter = await recallOwned(clientA, USER_A, "Correction from client");
    requestIds.push(`recall-after`);
    const current = findDbItem(recallAfter, memId);
    if (!current || current.ref.kind !== "db" || current.ref.version !== String(rev + 1)) {
      return fail("Two-client stale race", Date.now() - start, requestIds, {
        stage: "recall-verify", code: "winner_not_served",
        message: `Winning revision not served: ${JSON.stringify(current?.ref ?? null)}`,
      });
    }

    return pass("Two-client stale race", Date.now() - start, requestIds);
  } finally {
    await clientB.close();
    await clientA.close();
  }
};

export const ownerIsolation: ScenarioFn = async (fixture, runId) => {
  const start = Date.now();
  const requestIds: string[] = [];
  const clientA = await fixture.createClient(USER_A);
  const clientB = await fixture.createClient(USER_A);

  try {
    const tokenA = `${runId}-iso-a`;

    const storeA = await clientA.privateMemory.instantStore({
      userId: USER_A,
      contentEn: "User A's private memory",
      contentOriginal: "User A's private memory",
      memoryType: "fact",
      emotionScore: 0.5,
      keyword: tokenA,
      createdBy: "e2e-test",
    }, tokenA);

    if (!storeA.stored || !storeA.memoryId || !storeA.semanticRevision) {
      return fail("Owner isolation", Date.now() - start, requestIds, {
        stage: "store-A", code: "store_failed", message: JSON.stringify(storeA),
      });
    }
    requestIds.push(`store-A`);
    const aMemId = storeA.memoryId;

    // #1658: extracted_memories is Master-only creation. User B's row is
    // legacy data seeded directly (as pre-policy rows exist), proving recall
    // isolation without a foreign creation path.
    await fixture.seedMemory({
      userId: USER_B,
      contentEn: "User B's private memory",
      contentOriginal: "User B's private memory",
    });
    requestIds.push(`seed-B`);

    // A foreign principal cannot store under another owner's identity.
    const foreignStore = await settled(clientB.privateMemory.instantStore({
      userId: USER_B,
      contentEn: "User B tries to store",
      contentOriginal: "User B tries to store",
      memoryType: "fact",
      emotionScore: 0.5,
      keyword: `${runId}-iso-b`,
      createdBy: "e2e-test",
    }, `${runId}-iso-b`));
    requestIds.push(`store-B`);
    const foreignStored = "stored" in foreignStore && foreignStore.stored === true;
    if (foreignStored) {
      return fail("Owner isolation", Date.now() - start, requestIds, {
        stage: "store-B", code: "foreign_store_allowed",
        message: `User B must not store: ${JSON.stringify(foreignStore)}`,
      });
    }

    // A foreign principal cannot recall: the request is unauthorized before
    // any index is consulted, so nothing leaks through empty results either.
    let foreignRejected = false;
    try {
      await recallOwned(clientB, USER_B, tokenA);
    } catch (err) {
      foreignRejected = err instanceof Error
        && (/not authorized|not the primary memory owner|forbidden/i.test(err.message)
          || (err as { code?: string }).code === "unauthorized");
    }
    requestIds.push(`recall-B`);
    if (!foreignRejected) {
      return fail("Owner isolation", Date.now() - start, requestIds, {
        stage: "recall-B", code: "foreign_recall_allowed",
        message: "User B's recall must be rejected, not served",
      });
    }

    // The primary owner still sees only primary-owned evidence: the legacy
    // foreign row refuses personal serving on every route.
    const recallA = await recallOwned(clientA, USER_A, "private memory");
    requestIds.push(`recall-A`);
    if (!recallA.items.some((i) => i.ref.kind === "db" && i.ref.recordId === aMemId)) {
      return fail("Owner isolation", Date.now() - start, requestIds, {
        stage: "recall-A", code: "content_missing",
        message: "User A's memory should still be visible to User A",
      });
    }
    if (recallA.items.some((i) => i.excerpt.includes("User B's private memory"))) {
      return fail("Owner isolation", Date.now() - start, requestIds, {
        stage: "recall-A", code: "foreign_leaked",
        message: "Legacy foreign content leaked into primary recall",
      });
    }

    return pass("Owner isolation", Date.now() - start, requestIds);
  } finally {
    await clientB.close();
    await clientA.close();
  }
};

export const idempotency: ScenarioFn = async (fixture, runId) => {
  const start = Date.now();
  const requestIds: string[] = [];
  const client = await fixture.createClient(USER_A);

  try {
    const token = `${runId}-idem`;
    const opKey = `${runId}-idem-key`;

    const replayPayload = {
      userId: USER_A,
      contentEn: "Idempotent store test",
      contentOriginal: "Idempotent store test",
      memoryType: "fact",
      emotionScore: 0.5,
      keyword: token,
      createdBy: "e2e-test",
    } as const;
    const store1 = await client.privateMemory.instantStore(replayPayload, opKey);
    requestIds.push(`store-1`);

    if (!store1.stored || !store1.memoryId || !store1.semanticRevision) {
      return fail("Idempotency", Date.now() - start, requestIds, {
        stage: "store-1", code: "store_failed", message: JSON.stringify(store1),
      });
    }

    const store2 = await client.privateMemory.instantStore(replayPayload, opKey);
    requestIds.push(`store-2`);

    if (!store2.stored) {
      return fail("Idempotency", Date.now() - start, requestIds, {
        stage: "store-2", code: "store_failed", message: JSON.stringify(store2),
      });
    }
    if (store2.memoryId !== store1.memoryId || store2.semanticRevision !== store1.semanticRevision) {
      return fail("Idempotency", Date.now() - start, requestIds, {
        stage: "store-2-idempotent", code: "replay_mismatch",
        message: `Second store with same key returned different result: ${JSON.stringify(store2)} vs ${JSON.stringify(store1)}`,
      });
    }

    const recallAfter = await recallOwned(client, USER_A, token);
    requestIds.push(`recall-after`);

    const found = recallAfter.items.filter((i) => i.ref.kind === "db" && i.ref.recordId === store1.memoryId);
    if (found.length !== 1) {
      return fail("Idempotency", Date.now() - start, requestIds, {
        stage: "recall-verify", code: "duplicate_detected",
        message: `Expected exactly 1 memory, found ${found.length}`,
      });
    }

    // New-model corrections travel through the operator surface with
    // evidence-backed supersession (see the correction chain scenario);
    // idempotent reads of the same key converge on the stored row.
    const recallReplay = await recallOwned(client, USER_A, token);
    requestIds.push(`recall-replay`);
    const foundReplay = recallReplay.items.filter((i) => i.ref.kind === "db" && i.ref.recordId === store1.memoryId);
    if (foundReplay.length !== 1) {
      return fail("Idempotency", Date.now() - start, requestIds, {
        stage: "recall-replay", code: "duplicate_detected",
        message: `Expected exactly 1 memory on replay, found ${foundReplay.length}`,
      });
    }

    const changedPayloadKey = `${runId}-idem-changed`;
    const changedPayloadResult = await client.privateMemory.instantStore({
      userId: USER_A,
      contentEn: "First payload with key",
      contentOriginal: "First payload with key",
      memoryType: "fact",
      emotionScore: 0.5,
      keyword: `${token}-changed`,
      createdBy: "e2e-test",
    }, changedPayloadKey);
    requestIds.push(`changed-payload-1`);

    if (!changedPayloadResult.stored) {
      return fail("Idempotency", Date.now() - start, requestIds, {
        stage: "changed-payload-1", code: "store_failed", message: JSON.stringify(changedPayloadResult),
      });
    }

    try {
      await client.privateMemory.instantStore({
        userId: USER_A,
        contentEn: "Different payload with same key",
        contentOriginal: "Different payload with same key",
        memoryType: "fact",
        emotionScore: 0.5,
        keyword: `${token}-changed`,
        createdBy: "e2e-test",
      }, changedPayloadKey);
      return fail("Idempotency", Date.now() - start, requestIds, {
        stage: "changed-payload-2", code: "key_reuse_allowed",
        message: "Reusing idempotency key with changed payload should be rejected",
      });
    } catch {
      requestIds.push(`changed-payload-rejected`);
    }

    return pass("Idempotency", Date.now() - start, requestIds);
  } finally {
    await client.close();
  }
};

export const restartDurability: ScenarioFn = async (fixture, runId) => {
  const start = Date.now();
  const requestIds: string[] = [];
  const client = await fixture.createClient(USER_A);

  let memId: number;
  let rev: number;
  let token: string;
  let msgId: number;

  try {
    token = `${runId}-durable`;

    const msg = await client.privateMemory.recordMessage({
      userId: USER_A, sessionId: `${runId}-restart`, role: "user",
      content: `restart source ${token}`, timestamp: Date.now(),
    }, `${token}-msg`);
    if (msg.id == null) {
      return fail("Restart durability", Date.now() - start, requestIds, {
        stage: "record", code: "record_failed", message: JSON.stringify(msg),
      });
    }
    msgId = msg.id;
    requestIds.push(`record`);

    const store = await client.privateMemory.instantStore({
      userId: USER_A,
      contentEn: "Durable memory for restart test",
      contentOriginal: "Durable memory for restart test",
      memoryType: "fact",
      emotionScore: 0.5,
      keyword: token,
      sourceMessageIds: String(msg.id),
      createdBy: "e2e-test",
    }, token);

    if (!store.stored || !store.memoryId || !store.semanticRevision) {
      return fail("Restart durability", Date.now() - start, requestIds, {
        stage: "store", code: "store_failed", message: JSON.stringify(store),
      });
    }
    memId = store.memoryId;
    rev = store.semanticRevision;
    requestIds.push(`store`);
  } finally {
    await client.close();
  }

  await fixture.stopOwner();
  await fixture.startOwner();

  const client2 = await fixture.createClient();
  try {
    const recallAfter = await recallOwned(client2, USER_A, token!);
    requestIds.push(`recall-after-restart`);

    const found = findDbItem(recallAfter, memId!);
    if (!found) {
      return fail("Restart durability", Date.now() - start, requestIds, {
        stage: "recall-after-restart", code: "memory_lost",
        message: `Memory ${memId} not found after daemon restart`,
      });
    }

    // Correction after restart goes through the same operator surface and
    // the serving generation reflects the new revision.
    const corrected = await fixture.personalCli([
      "--action", "correct",
      "--durable-id", String(memId!),
      "--expected-revision", String(rev!),
      "--content", "Corrected after restart",
      "--authority", "user_statement",
      "--authority-basis", "restart journey",
      "--scope", '{"scope":"general"}',
      "--evidence-message-ids", String(msgId!),
    ]);
    requestIds.push(`correct-after-restart`);

    const correctedRef = (corrected["result"] as Record<string, unknown> | undefined)?.["revision"] as
      number | undefined;
    if (corrected["ok"] !== true || correctedRef !== rev! + 1) {
      return fail("Restart durability", Date.now() - start, requestIds, {
        stage: "correct-after-restart", code: "correct_failed",
        message: `Could not correct after restart: ${JSON.stringify(corrected)}`,
      });
    }

    return pass("Restart durability", Date.now() - start, requestIds);
  } finally {
    await client2.close();
  }
};

export const cascadeDeletion: ScenarioFn = async (fixture, runId) => {
  const start = Date.now();
  const requestIds: string[] = [];
  const clientA = await fixture.createClient(USER_A);

  try {
    const ownMarker = `${runId}-cascade-own`;

    const ownRecord = await clientA.privateMemory.recordMessage({
      userId: USER_A, sessionId: "s-cascade", role: "user", content: `cascade source ${ownMarker}`, timestamp: Date.now(),
    }, `${runId}-record-own`);
    requestIds.push(`record-own`);

    if (ownRecord.id == null) {
      return fail("Cascade deletion", Date.now() - start, requestIds, {
        stage: "record", code: "record_failed", message: JSON.stringify(ownRecord),
      });
    }

    const linkedStore = await clientA.privateMemory.instantStore({
      userId: USER_A,
      contentEn: `Cascade linked memory ${ownMarker}`,
      contentOriginal: `Cascade linked memory ${ownMarker}`,
      memoryType: "fact",
      emotionScore: 0.5,
      keyword: `${runId}-cascade-linked`,
      sourceMessageIds: String(ownRecord.id),
      createdBy: "e2e-test",
    }, `${runId}-store-linked`);
    requestIds.push(`store-linked`);

    if (!linkedStore.stored || !linkedStore.memoryId) {
      return fail("Cascade deletion", Date.now() - start, requestIds, {
        stage: "store-linked", code: "store_failed", message: JSON.stringify(linkedStore),
      });
    }

    // Forgetting the source message suppresses the linked memory: the new
    // model forgets through markers with derived cleanup, not legacy
    // cascade deletes.
    const forgotten = await fixture.personalCli([
      "--action", "forget", "--message-ids", String(ownRecord.id),
    ]);
    requestIds.push(`forget`);
    if (forgotten["ok"] !== true) {
      return fail("Cascade deletion", Date.now() - start, requestIds, {
        stage: "forget", code: "forget_failed", message: JSON.stringify(forgotten),
      });
    }

    const linkedRecall = await recallOwned(clientA, USER_A, `${runId}-cascade-linked`);
    requestIds.push(`verify-memory`);
    if (linkedRecall.items.some((i) => i.ref.kind === "db" && i.ref.recordId === linkedStore.memoryId)) {
      return fail("Cascade deletion", Date.now() - start, requestIds, {
        stage: "verify-memory", code: "memory_survived", message: "Linked memory survived the source forget",
      });
    }

    // Forgetting again is idempotent: the barrier holds, nothing resurrects.
    const replay = await fixture.personalCli([
      "--action", "forget", "--message-ids", String(ownRecord.id),
    ]);
    requestIds.push(`forget-replay`);
    if (replay["ok"] !== true) {
      return fail("Cascade deletion", Date.now() - start, requestIds, {
        stage: "forget-replay", code: "replay_failed", message: JSON.stringify(replay),
      });
    }
    const afterReplay = await recallOwned(clientA, USER_A, `${runId}-cascade-linked`);
    if (afterReplay.items.some((i) => i.ref.kind === "db" && i.ref.recordId === linkedStore.memoryId)) {
      return fail("Cascade deletion", Date.now() - start, requestIds, {
        stage: "forget-replay", code: "resurrected", message: "Memory resurrected after forget replay",
      });
    }

    return pass("Cascade deletion", Date.now() - start, requestIds);
  } finally {
    await clientA.close();
  }
};

export const cascadeGrantDenial: ScenarioFn = async (fixture, runId) => {
  const start = Date.now();
  const requestIds: string[] = [];
  const NO_CASCADE_PRINCIPAL = "no-cascade-principal";

  if (!fixture.grantEnforcement) {
    // The local Unix lane has no per-peer grant model; the denial semantic
    // (unauthorized, not validation_error) is exercised where grants exist.
    return pass("Cascade grant denial (peer)", Date.now() - start, requestIds);
  }

  const client = await fixture.createClient(NO_CASCADE_PRINCIPAL);
  try {
    if (!client.capabilities) {
      return fail("Cascade grant denial (peer)", Date.now() - start, requestIds, {
        stage: "negotiate", code: "no_capabilities", message: "Capabilities are null",
      });
    }
    if (client.capabilities.methods.includes("private.cascadeDelete")) {
      return fail("Cascade grant denial (peer)", Date.now() - start, requestIds, {
        stage: "negotiate", code: "cascade_advertised",
        message: "A peer without the cascade grant must not advertise private.cascadeDelete",
      });
    }

    try {
      await client.privateMemory.cascadeDelete({
        userId: NO_CASCADE_PRINCIPAL,
        messageIds: [1],
      }, `${runId}-no-cascade-key`);
      return fail("Cascade grant denial (peer)", Date.now() - start, requestIds, {
        stage: "invoke", code: "denial_missing",
        message: "Direct private.cascadeDelete invocation should have been denied",
      });
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      requestIds.push(`denial`);
      if (code !== "unauthorized") {
        return fail("Cascade grant denial (peer)", Date.now() - start, requestIds, {
          stage: "invoke", code: "wrong_error",
          message: `Expected unauthorized, got ${code}: ${(err as Error).message}`,
        });
      }
    }

    return pass("Cascade grant denial (peer)", Date.now() - start, requestIds);
  } finally {
    await client.close();
  }
};

/**
 * #1527 — durable context projection: the same scenario runs on the local
 * Unix and signed-WSS lanes and must return equivalent normalized results.
 * Records two prior turns plus one current cursor, then asserts strict
 * exclusivity, ordered history, and bounded denial semantics.
 */
const durableContextProjection: ScenarioFn = async (fixture, runId) => {
  const start = Date.now();
  const requestIds: string[] = [];
  const client = await fixture.createClient(USER_A);
  try {
    if (!client.capabilities) {
      return fail("Durable context projection", Date.now() - start, requestIds, {
        stage: "negotiate", code: "no_capabilities", message: "Capabilities are null",
      });
    }
    if (!client.capabilities.methods.includes("private.projectConversationContext")) {
      return fail("Durable context projection", Date.now() - start, requestIds, {
        stage: "negotiate", code: "projection_not_advertised",
        message: "private.projectConversationContext must be advertised",
      });
    }

    const sessionId = `${runId}-projection-session`;
    const id1 = (await client.privateMemory.recordMessage({
      userId: USER_A, sessionId, role: "user", content: "first user turn", timestamp: Date.now() - 3000,
    }, `${runId}-proj-1`)).id;
    const id2 = (await client.privateMemory.recordMessage({
      userId: USER_A, sessionId, role: "assistant", content: "first assistant turn", timestamp: Date.now() - 2000,
    }, `${runId}-proj-2`)).id;
    const id3 = (await client.privateMemory.recordMessage({
      userId: USER_A, sessionId, role: "user", content: "middle user turn", timestamp: Date.now() - 1000,
    }, `${runId}-proj-3`)).id;
    const currentId = (await client.privateMemory.recordMessage({
      userId: USER_A, sessionId, role: "user", content: "second user turn", timestamp: Date.now(),
    }, `${runId}-proj-4`)).id;
    requestIds.push(`record-${id1}`, `record-${id2}`, `record-${id3}`, `record-${currentId}`);
    if (id1 == null || id2 == null || id3 == null || currentId == null || !(currentId > id3 && id3 > id2 && id2 > id1)) {
      return fail("Durable context projection", Date.now() - start, requestIds, {
        stage: "record", code: "cursor_invalid",
        message: `Recorded ids are not strictly ordered: ${id1} < ${id2} < ${id3} < ${currentId}`,
      });
    }

    const projected = await client.privateMemory.projectConversationContext({
      userId: USER_A, sessionId, beforeMessageId: currentId, maxContext: 100_000,
    });
    requestIds.push("project");

    if (projected.version !== 1) {
      return fail("Durable context projection", Date.now() - start, requestIds, {
        stage: "project", code: "wrong_version", message: `Expected version 1, got ${projected.version}`,
      });
    }
    if (projected.sourceMessageCount !== 3) {
      return fail("Durable context projection", Date.now() - start, requestIds, {
        stage: "project", code: "wrong_source_count",
        message: `Expected 3 source messages, got ${projected.sourceMessageCount}`,
      });
    }
    const contents = projected.messages.map(m => m.content);
    if (contents.length !== 3 || contents[0] !== "first user turn" || contents[1] !== "first assistant turn" || contents[2] !== "middle user turn") {
      return fail("Durable context projection", Date.now() - start, requestIds, {
        stage: "project", code: "wrong_history",
        message: `Expected ordered history, got ${JSON.stringify(contents)}`,
      });
    }
    if (contents.includes("second user turn")) {
      return fail("Durable context projection", Date.now() - start, requestIds, {
        stage: "project", code: "cursor_leak",
        message: "The current cursor row leaked into the projection",
      });
    }
    if (projected.estimatedTokens <= 0) {
      return fail("Durable context projection", Date.now() - start, requestIds, {
        stage: "project", code: "no_tokens",
        message: `Estimated tokens must be positive, got ${projected.estimatedTokens}`,
      });
    }

    // Cursor exclusivity: projecting before the middle user row returns only
    // the two prior rows in order.
    const narrowed = await client.privateMemory.projectConversationContext({
      userId: USER_A, sessionId, beforeMessageId: id3, maxContext: 100_000,
    });
    requestIds.push("project-narrowed");
    const narrowedContents = narrowed.messages.map(m => m.content);
    if (narrowedContents.length !== 2 || narrowedContents[0] !== "first user turn" || narrowedContents[1] !== "first assistant turn") {
      return fail("Durable context projection", Date.now() - start, requestIds, {
        stage: "project-narrowed", code: "cursor_not_exclusive",
        message: `Expected only [first user turn, first assistant turn], got ${JSON.stringify(narrowedContents)}`,
      });
    }

    // #1883/A1: more than 70 short rows stay fully represented with ample
    // budget. Short fixtures keep the serialized success far below the
    // declared output bound; the oversized fixture below covers overflow.
    const journeySession = `${runId}-projection-journey`;
    const journeyMarkers: string[] = [];
    const journeyIds: number[] = [];
    for (let i = 0; i < 80; i++) {
      const marker = `journey-${runId}-${i}-m${i * 7 + 3}`;
      journeyMarkers.push(marker);
      const recorded = await client.privateMemory.recordMessage({
        userId: USER_A, sessionId: journeySession,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `journey message ${marker} with some prose`,
        timestamp: Date.now() - (80 - i) * 1000,
        ...(i % 2 === 0 ? { typeHint: "F", topicHint: "coding" } : {}),
      }, `${runId}-journey-${i}`);
      if (recorded.id == null) {
        return fail("Durable context projection", Date.now() - start, requestIds, {
          stage: "journey-record", code: "record_failed",
          message: `Journey row ${i} returned no id`,
        });
      }
      journeyIds.push(recorded.id);
    }
    const journeyCursor = (await client.privateMemory.recordMessage({
      userId: USER_A, sessionId: journeySession, role: "user",
      content: "journey current turn", timestamp: Date.now(),
    }, `${runId}-journey-cursor`)).id;
    requestIds.push("journey-record-80", "journey-cursor");
    if (journeyCursor == null || !(journeyCursor > journeyIds[journeyIds.length - 1]!)) {
      return fail("Durable context projection", Date.now() - start, requestIds, {
        stage: "journey-record", code: "cursor_invalid",
        message: "Journey cursor id is not after the recorded history",
      });
    }

    const journey = await client.privateMemory.projectConversationContext({
      userId: USER_A, sessionId: journeySession, beforeMessageId: journeyCursor, maxContext: 10_000_000,
    });
    requestIds.push("project-journey");
    if (journey.sourceMessageCount !== 80) {
      return fail("Durable context projection", Date.now() - start, requestIds, {
        stage: "project-journey", code: "wrong_source_count",
        message: `Expected 80 source messages, got ${journey.sourceMessageCount}`,
      });
    }
    const journeyContents = journey.messages.map(m => m.content);
    if (journeyContents.length !== 80) {
      return fail("Durable context projection", Date.now() - start, requestIds, {
        stage: "project-journey", code: "history_omitted",
        message: `Expected 80 represented rows, got ${journeyContents.length}`,
      });
    }
    let lastAt = -1;
    for (const marker of journeyMarkers) {
      const at = journeyContents.findIndex(c => c.includes(marker));
      if (at <= lastAt || journeyContents.filter(c => c.includes(marker)).length !== 1) {
        return fail("Durable context projection", Date.now() - start, requestIds, {
          stage: "project-journey", code: "history_not_once_ordered",
          message: `Marker ${marker} is not represented exactly once in ID order`,
        });
      }
      lastAt = at;
    }
    if (journeyContents.includes("journey current turn")) {
      return fail("Durable context projection", Date.now() - start, requestIds, {
        stage: "project-journey", code: "cursor_leak",
        message: "The journey cursor row leaked into the projection",
      });
    }

    // #1883/A6: a complete history that exceeds the enforced output bound
    // fails through the existing bounded service/route error — no partial
    // history, no widened limits — and leaves durable state unchanged.
    // Separate fixtures from the short A1 success journey above.
    const overflowSession = `${runId}-projection-overflow`;
    const overflowIds: number[] = [];
    const bigChunk = `overflow-${runId}-` + "x".repeat(40_000);
    for (let i = 0; i < 15; i++) {
      const recorded = await client.privateMemory.recordMessage({
        userId: USER_A, sessionId: overflowSession,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `${bigChunk}-row${i}`,
        timestamp: Date.now() - (15 - i) * 1000,
      }, `${runId}-overflow-${i}`);
      if (recorded.id == null) {
        return fail("Durable context projection", Date.now() - start, requestIds, {
          stage: "overflow-record", code: "record_failed",
          message: `Overflow row ${i} returned no id`,
        });
      }
      overflowIds.push(recorded.id);
    }
    const overflowCursor = (await client.privateMemory.recordMessage({
      userId: USER_A, sessionId: overflowSession, role: "user",
      content: "overflow current turn", timestamp: Date.now(),
    }, `${runId}-overflow-cursor`)).id;
    requestIds.push("overflow-record-15", "overflow-cursor");
    if (overflowCursor == null) {
      return fail("Durable context projection", Date.now() - start, requestIds, {
        stage: "overflow-record", code: "cursor_invalid",
        message: "Overflow cursor id is missing",
      });
    }
    let overflowCode = "";
    try {
      await client.privateMemory.projectConversationContext({
        userId: USER_A, sessionId: overflowSession, beforeMessageId: overflowCursor, maxContext: 10_000_000,
      });
      requestIds.push("project-overflow");
      return fail("Durable context projection", Date.now() - start, requestIds, {
        stage: "project-overflow", code: "overflow_admitted",
        message: "An oversized projection must fail through the existing output bound",
      });
    } catch (err) {
      overflowCode = (err as Error & { code?: string }).code ?? "";
      requestIds.push("project-overflow");
      // Routes may impose different bounds; every accepted code is a bounded
      // failure, never partial-history success.
      if (!["validation_error", "unavailable", "outcome_unknown"].includes(overflowCode)) {
        return fail("Durable context projection", Date.now() - start, requestIds, {
          stage: "project-overflow", code: "wrong_error",
          message: `Expected a bounded overflow failure, got ${overflowCode}: ${(err as Error).message}`,
        });
      }
    }
    // Durable state is unchanged: a narrowed projection still returns the
    // exact prefix rows recorded before the overflow attempt. Index 4 is a
    // user row (roles alternate user/assistant from index 0), so it is a
    // valid cursor bounding rows 0..3.
    const narrowedOverflow = await client.privateMemory.projectConversationContext({
      userId: USER_A, sessionId: overflowSession, beforeMessageId: overflowIds[4]!, maxContext: 10_000_000,
    });
    requestIds.push("project-overflow-narrowed");
    const overflowPrefix = narrowedOverflow.messages.map(m => m.content);
    if (narrowedOverflow.sourceMessageCount !== 4 || overflowPrefix.length !== 4
      || !overflowPrefix[0]!.includes(`${bigChunk}-row0`)
      || !overflowPrefix[3]!.includes(`${bigChunk}-row3`)) {
      return fail("Durable context projection", Date.now() - start, requestIds, {
        stage: "project-overflow-narrowed", code: "state_changed",
        message: `Overflow attempt changed durable state (code was ${overflowCode})`,
      });
    }

    // Cross-principal denial only exists where per-peer grants are enforced.
    if (fixture.grantEnforcement) {
      const other = await fixture.createClient(USER_B);
      try {
        await other.privateMemory.projectConversationContext({
          userId: USER_B, sessionId, beforeMessageId: currentId, maxContext: 100_000,
        });
        requestIds.push("denial");
        return fail("Durable context projection", Date.now() - start, requestIds, {
          stage: "denial", code: "denial_missing",
          message: "A foreign principal must not project another user's session",
        });
      } catch (err) {
        const code = (err as Error & { code?: string }).code;
        requestIds.push("denial");
        if (code !== "unauthorized" && code !== "not_found") {
          return fail("Durable context projection", Date.now() - start, requestIds, {
            stage: "denial", code: "wrong_error",
            message: `Expected unauthorized/not_found, got ${code}: ${(err as Error).message}`,
          });
        }
      } finally {
        await other.close();
      }
    }

    return pass("Durable context projection", Date.now() - start, requestIds);
  } finally {
    await client.close();
  }
};

export const scenarios: Array<{ name: string; fn: ScenarioFn }> = [
  { name: "Projection activation", fn: projectionActivation },
  { name: "Lifecycle and capabilities", fn: lifecycleCapabilities },
  { name: "Store and recall", fn: storeAndRecall },
  { name: "Semantic mutation chain", fn: semanticMutationChain },
  { name: "Two-client stale race", fn: twoClientStaleRace },
  { name: "Owner isolation", fn: ownerIsolation },
  { name: "Idempotency", fn: idempotency },
  { name: "Restart durability", fn: restartDurability },
  { name: "Route loss and recovery", fn: routeLossRecovery },
  { name: "Cascade deletion", fn: cascadeDeletion },
  { name: "Cascade grant denial (peer)", fn: cascadeGrantDenial },
  { name: "Durable context projection", fn: durableContextProjection },
];
