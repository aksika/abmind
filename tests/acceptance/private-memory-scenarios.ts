import type { AbmindClient } from "abmind";
import type { AcceptanceFixture, ScenarioResult } from "./contracts.js";
import { pass, fail } from "./scenario-helpers.js";

const USER_A = "e2e-user-a";
const USER_B = "e2e-user-b";

type ScenarioFn = (fixture: AcceptanceFixture, runId: string) => Promise<ScenarioResult>;

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
    if (!first.stored || !first.memoryId) {
      return fail("Route loss and recovery", Date.now() - start, requestIds, {
        stage: "redelivery", code: "store_failed",
        message: `Store after recovery failed: ${JSON.stringify(first)}`,
      });
    }
    const second = await client.privateMemory.instantStore({
      userId: USER_A, contentEn: content, contentOriginal: content,
      memoryType: "fact", emotionScore: 0.5, confidence: 5, classification: 1,
    }, key);
    if (second.memoryId !== first.memoryId) {
      return fail("Route loss and recovery", Date.now() - start, requestIds, {
        stage: "redelivery", code: "idempotency_violated",
        message: `Same key produced memoryId ${first.memoryId} then ${second.memoryId}`,
      });
    }

    const recall = await client.privateMemory.recall({
      translated: [content], original: content, userId: USER_A, limit: 10,
    });
    const matches = recall.results.filter((hit: { content?: string }) => (hit.content ?? "").includes(content));
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

// ISO 8601 constant for validTo tests
const FUTURE_DATE = "2099-12-31";

const LIVE_CAPABILITY_METHODS = [
  "private.instantStore",
  "private.edit",
  "private.reclassify",
  "private.adjustRelevance",
  "private.merge",
  "private.cascadeDelete",
  "private.recall",
  "private.recordMessage",
  "private.getRuntimeStatus",
  "private.getCoreKnowledge",
  "private.recordFeedback",
  "private.embed",
  "private.rebuildFts",
  "private.getRecentConversation",
  "private.assembleSessionContext",
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

    const recallResult = await client.privateMemory.recall({
      translated: [tokenA],
      original: tokenA,
      userId: USER_A,
      limit: 10,
    });
    requestIds.push(`recall-A`);

    const found = recallResult.results.find(r => r.id === storeA.memoryId);
    if (!found) {
      return fail("Store and recall", Date.now() - start, requestIds, {
        stage: "recall-verify", code: "not_found", message: `Memory ${storeA.memoryId} not found in recall results`,
      });
    }

    if (found.semanticRevision !== storeA.semanticRevision) {
      return fail("Store and recall", Date.now() - start, requestIds, {
        stage: "recall-revision", code: "revision_mismatch",
        message: `Expected revision ${storeA.semanticRevision}, got ${found.semanticRevision}`,
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

    const store = await client.privateMemory.instantStore({
      userId: USER_A,
      contentEn: "Initial content for mutation chain",
      contentOriginal: "Initial content for mutation chain",
      memoryType: "fact",
      emotionScore: 0.5,
      keyword: token,
      createdBy: "e2e-test",
    }, token);

    if (!store.stored || !store.memoryId || !store.semanticRevision) {
      return fail("Semantic mutation chain", Date.now() - start, requestIds, {
        stage: "store", code: "store_failed", message: JSON.stringify(store),
      });
    }
    requestIds.push(`store`);

    let rev = store.semanticRevision;

    const edit = await client.privateMemory.editMemory({
      userId: USER_A,
      memoryId: store.memoryId,
      expectedRevision: rev,
      contentEn: "Edited content for mutation chain",
    });
    requestIds.push(`edit`);

    if (!edit.ok || !edit.ref || edit.ref.semanticRevision !== rev + 1) {
      return fail("Semantic mutation chain", Date.now() - start, requestIds, {
        stage: "edit", code: "edit_failed", message: JSON.stringify(edit),
      });
    }
    rev = edit.ref.semanticRevision;

    const reclassify = await client.privateMemory.reclassifyMemory({
      userId: USER_A,
      memoryId: store.memoryId,
      expectedRevision: rev,
      classification: 2,
    });
    requestIds.push(`reclassify`);

    if (!reclassify.ok || !reclassify.ref || reclassify.ref.semanticRevision !== rev + 1) {
      return fail("Semantic mutation chain", Date.now() - start, requestIds, {
        stage: "reclassify", code: "reclassify_failed", message: JSON.stringify(reclassify),
      });
    }
    rev = reclassify.ref.semanticRevision;

    const adjust = await client.privateMemory.adjustRelevance({
      userId: USER_A,
      memoryId: store.memoryId,
      expectedRevision: rev,
      delta: 10,
    });
    requestIds.push(`adjustRelevance`);

    if (!adjust.ok || !adjust.ref || adjust.ref.semanticRevision !== rev + 1) {
      return fail("Semantic mutation chain", Date.now() - start, requestIds, {
        stage: "adjustRelevance", code: "adjust_failed", message: JSON.stringify(adjust),
      });
    }
    rev = adjust.ref.semanticRevision;

    const store2 = await client.privateMemory.instantStore({
      userId: USER_A,
      contentEn: "Second memory for merge",
      contentOriginal: "Second memory for merge",
      memoryType: "fact",
      emotionScore: 0.5,
      keyword: `${token}-second`,
      createdBy: "e2e-test",
    }, `${token}-second`);

    if (!store2.stored || !store2.memoryId || !store2.semanticRevision) {
      return fail("Semantic mutation chain", Date.now() - start, requestIds, {
        stage: "store-2", code: "store_failed", message: JSON.stringify(store2),
      });
    }
    requestIds.push(`store-2`);

    const merge = await client.privateMemory.mergeMemories({
      userId: USER_A,
      first: { memoryId: store.memoryId, semanticRevision: rev },
      second: { memoryId: store2.memoryId, semanticRevision: store2.semanticRevision },
    });
    requestIds.push(`merge`);

    if (!merge.ok || !merge.ref || !merge.deletedId) {
      return fail("Semantic mutation chain", Date.now() - start, requestIds, {
        stage: "merge", code: "merge_failed", message: JSON.stringify(merge),
      });
    }

    const recallAfter = await client.privateMemory.recall({
      translated: [token],
      original: token,
      userId: USER_A,
      limit: 10,
    });
    requestIds.push(`recall-after`);

    const survivor = recallAfter.results.find(r => r.id === merge.ref!.memoryId);
    if (!survivor) {
      return fail("Semantic mutation chain", Date.now() - start, requestIds, {
        stage: "recall-verify", code: "survivor_not_found",
        message: `Survivor memory ${merge.ref!.memoryId} not found after merge`,
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

    const store = await clientA.privateMemory.instantStore({
      userId: USER_A,
      contentEn: "Race condition test memory",
      contentOriginal: "Race condition test memory",
      memoryType: "fact",
      emotionScore: 0.5,
      keyword: token,
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

    const [resultA, resultB] = await Promise.all([
      clientA.privateMemory.editMemory({
        userId: USER_A, memoryId: memId, expectedRevision: rev,
        contentEn: "Edit from client A",
      }),
      clientB.privateMemory.editMemory({
        userId: USER_A, memoryId: memId, expectedRevision: rev,
        contentEn: "Edit from client B",
      }),
    ]);
    requestIds.push(`edit-A`, `edit-B`);

    const successes = [resultA, resultB].filter(r => r.ok).length;
    const conflicts = [resultA, resultB].filter(r => !r.ok && r.code === "conflict").length;

    if (successes !== 1 || conflicts !== 1) {
      return fail("Two-client stale race", Date.now() - start, requestIds, {
        stage: "race", code: "unexpected_outcome",
        message: `Expected 1 success + 1 conflict, got ${successes} success + ${conflicts} conflict. ` +
          `A=${JSON.stringify(resultA)} B=${JSON.stringify(resultB)}`,
      });
    }

    const conflict = [resultA, resultB].find(r => !r.ok && r.code === "conflict")!;
    if (!conflict.current || conflict.current.memoryId !== memId) {
      return fail("Two-client stale race", Date.now() - start, requestIds, {
        stage: "conflict-shape", code: "invalid_conflict",
        message: `Conflict missing expected current ref: ${JSON.stringify(conflict)}`,
      });
    }

    const recallAfter = await clientA.privateMemory.recall({
      translated: [token], original: token, userId: USER_A, limit: 5,
    });
    requestIds.push(`recall-after`);

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
  const clientB = await fixture.createClient(USER_B);

  try {
    const tokenA = `${runId}-iso-a`;
    const tokenB = `${runId}-iso-b`;

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

    const storeB = await clientB.privateMemory.instantStore({
      userId: USER_B,
      contentEn: "User B's private memory",
      contentOriginal: "User B's private memory",
      memoryType: "fact",
      emotionScore: 0.5,
      keyword: tokenB,
      createdBy: "e2e-test",
    }, tokenB);
    if (!storeB.stored) {
      return fail("Owner isolation", Date.now() - start, requestIds, {
        stage: "store-B", code: "store_failed", message: JSON.stringify(storeB),
      });
    }
    requestIds.push(`store-B`);

    const aMemId = storeA.memoryId;
    const aRev = storeA.semanticRevision;

    const mutations: Array<{ name: string; call: () => Promise<{ ok: boolean }> }> = [
      {
        name: "edit",
        call: () => clientB.privateMemory.editMemory({
          userId: USER_B, memoryId: aMemId, expectedRevision: aRev,
          contentEn: "User B tries to edit A's memory",
        }),
      },
      {
        name: "reclassify",
        call: () => clientB.privateMemory.reclassifyMemory({
          userId: USER_B, memoryId: aMemId, expectedRevision: aRev, classification: 2,
        }),
      },
      {
        name: "adjustRelevance",
        call: () => clientB.privateMemory.adjustRelevance({
          userId: USER_B, memoryId: aMemId, expectedRevision: aRev, delta: 10,
        }),
      },
    ];

    for (const mut of mutations) {
      const result = await mut.call();
      requestIds.push(`cross-${mut.name}`);
      if (result.ok) {
        return fail("Owner isolation", Date.now() - start, requestIds, {
          stage: `cross-${mut.name}`, code: "cross_user_allowed",
          message: `User B should not be able to ${mut.name} User A's memory, but the mutation succeeded`,
        });
      }
    }

    const recallA = await clientA.privateMemory.recall({
      translated: [tokenA], original: tokenA, userId: USER_A, limit: 5,
    });
    const recallB = await clientB.privateMemory.recall({
      translated: [tokenB], original: tokenB, userId: USER_B, limit: 5,
    });
    requestIds.push(`recall-A`, `recall-B`);

    if (recallA.results.length === 0) {
      return fail("Owner isolation", Date.now() - start, requestIds, {
        stage: "recall-A", code: "content_missing",
        message: "User A's memory should still be visible to User A",
      });
    }
    if (recallB.results.length === 0) {
      return fail("Owner isolation", Date.now() - start, requestIds, {
        stage: "recall-B", code: "content_missing",
        message: "User B's memory should still be visible to User B",
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

    if (store2.memoryId !== store1.memoryId || store2.semanticRevision !== store1.semanticRevision) {
      return fail("Idempotency", Date.now() - start, requestIds, {
        stage: "store-2-idempotent", code: "replay_mismatch",
        message: `Second store with same key returned different result: ${JSON.stringify(store2)} vs ${JSON.stringify(store1)}`,
      });
    }

    const recallAfter = await client.privateMemory.recall({
      translated: [token], original: token, userId: USER_A, limit: 5,
    });
    requestIds.push(`recall-after`);

    const found = recallAfter.results.filter(r => r.id === store1.memoryId);
    if (found.length !== 1) {
      return fail("Idempotency", Date.now() - start, requestIds, {
        stage: "recall-verify", code: "duplicate_detected",
        message: `Expected exactly 1 memory, found ${found.length}`,
      });
    }

    const editKey = `${runId}-idem-edit-key`;
    const editResult = await client.privateMemory.editMemory({
      userId: USER_A, memoryId: store1.memoryId, expectedRevision: store1.semanticRevision,
      contentEn: "Idempotent edit test",
    }, editKey);
    requestIds.push(`edit-1`);

    if (!editResult.ok || !editResult.ref) {
      return fail("Idempotency", Date.now() - start, requestIds, {
        stage: "edit-1", code: "edit_failed", message: JSON.stringify(editResult),
      });
    }

    const editReplay = await client.callRaw<{ ok: boolean; ref?: { memoryId: number; semanticRevision: number } }>(
      "private.edit",
      { userId: USER_A, memoryId: store1.memoryId, expectedRevision: store1.semanticRevision, contentEn: "Idempotent edit test" },
      editKey,
    );
    requestIds.push(`edit-replay`);

    if (!editReplay.ok || editReplay.ref?.semanticRevision !== editResult.ref.semanticRevision) {
      return fail("Idempotency", Date.now() - start, requestIds, {
        stage: "edit-replay", code: "replay_mismatch",
        message: `Edit replay via callRaw returned different result: ${JSON.stringify(editReplay)} vs ${JSON.stringify(editResult)}`,
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

  try {
    token = `${runId}-durable`;

    const store = await client.privateMemory.instantStore({
      userId: USER_A,
      contentEn: "Durable memory for restart test",
      contentOriginal: "Durable memory for restart test",
      memoryType: "fact",
      emotionScore: 0.5,
      keyword: token,
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

    const edit = await client.privateMemory.editMemory({
      userId: USER_A, memoryId: memId, expectedRevision: rev,
      contentEn: "Edited before restart",
    });
    requestIds.push(`edit-before-restart`);

    if (!edit.ok || !edit.ref) {
      return fail("Restart durability", Date.now() - start, requestIds, {
        stage: "edit-before-restart", code: "edit_failed", message: JSON.stringify(edit),
      });
    }
    rev = edit.ref.semanticRevision;
  } finally {
    await client.close();
  }

  await fixture.stopOwner();
  await fixture.startOwner();

  const client2 = await fixture.createClient();
  try {
    const recallAfter = await client2.privateMemory.recall({
      translated: [token!], original: token!, userId: USER_A, limit: 5,
    });
    requestIds.push(`recall-after-restart`);

    const found = recallAfter.results.find(r => r.id === memId!);
    if (!found) {
      return fail("Restart durability", Date.now() - start, requestIds, {
        stage: "recall-after-restart", code: "memory_lost",
        message: `Memory ${memId} not found after daemon restart`,
      });
    }

    const editAfter = await client2.privateMemory.editMemory({
      userId: USER_A, memoryId: memId!, expectedRevision: rev!,
      contentEn: "Edited after restart",
    });
    requestIds.push(`edit-after-restart`);

    if (!editAfter.ok || !editAfter.ref) {
      return fail("Restart durability", Date.now() - start, requestIds, {
        stage: "edit-after-restart", code: "edit_failed",
        message: `Could not edit after restart: ${JSON.stringify(editAfter)}`,
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
  const clientB = await fixture.createClient(USER_B);

  try {
    if (!clientA.capabilities || !clientA.capabilities.methods.includes("private.cascadeDelete")) {
      return fail("Cascade deletion", Date.now() - start, requestIds, {
        stage: "negotiate", code: "cascade_not_advertised",
        message: "private.cascadeDelete must be advertised under the active contract",
      });
    }

    const ownMarker = `${runId}-cascade-own`;
    const foreignMarker = `${runId}-cascade-foreign`;

    const ownRecord = await clientA.privateMemory.recordMessage({
      userId: USER_A, sessionId: "s-cascade", role: "user", content: `cascade source ${ownMarker}`, timestamp: Date.now(),
    }, `${runId}-record-own`);
    const foreignRecord = await clientB.privateMemory.recordMessage({
      userId: USER_B, sessionId: "s-cascade", role: "user", content: `cascade source ${foreignMarker}`, timestamp: Date.now(),
    }, `${runId}-record-foreign`);
    requestIds.push(`record-own`, `record-foreign`);

    if (ownRecord.id == null || foreignRecord.id == null) {
      return fail("Cascade deletion", Date.now() - start, requestIds, {
        stage: "record", code: "record_failed",
        message: `own=${JSON.stringify(ownRecord)} foreign=${JSON.stringify(foreignRecord)}`,
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

    const key = `${runId}-cascade-key`;
    const payload = { userId: USER_A, messageIds: [ownRecord.id, foreignRecord.id] };

    const deleted = await clientA.privateMemory.cascadeDelete(payload, key);
    requestIds.push(`cascade`);

    if (deleted.messagesRemoved !== 1 || deleted.linkedMemoriesRemoved !== 1 || deleted.embeddingsRemoved !== 0) {
      return fail("Cascade deletion", Date.now() - start, requestIds, {
        stage: "cascade", code: "unexpected_counts", message: JSON.stringify(deleted),
      });
    }

    const ownConversation = await clientA.privateMemory.getRecentConversation({ userId: USER_A, since: 0, limit: 100 });
    const foreignConversation = await clientB.privateMemory.getRecentConversation({ userId: USER_B, since: 0, limit: 100 });
    requestIds.push(`verify-own`, `verify-foreign`);

    if (ownConversation.some(m => m.content.includes(ownMarker))) {
      return fail("Cascade deletion", Date.now() - start, requestIds, {
        stage: "verify-own", code: "message_survived", message: "Own cascade source message still present",
      });
    }
    if (!foreignConversation.some(m => m.content.includes(foreignMarker))) {
      return fail("Cascade deletion", Date.now() - start, requestIds, {
        stage: "verify-foreign", code: "foreign_lost", message: "Foreign message was removed by owner cascade",
      });
    }

    const linkedRecall = await clientA.privateMemory.recall({
      translated: [`${runId}-cascade-linked`], original: `${runId}-cascade-linked`, userId: USER_A, limit: 5,
    });
    requestIds.push(`verify-memory`);
    if (linkedRecall.results.some(r => r.id === linkedStore.memoryId)) {
      return fail("Cascade deletion", Date.now() - start, requestIds, {
        stage: "verify-memory", code: "memory_survived", message: "Linked memory survived the cascade",
      });
    }

    const replay = await clientA.privateMemory.cascadeDelete(payload, key);
    requestIds.push(`cascade-replay`);
    if (replay.messagesRemoved !== deleted.messagesRemoved
      || replay.linkedMemoriesRemoved !== deleted.linkedMemoriesRemoved
      || replay.embeddingsRemoved !== deleted.embeddingsRemoved) {
      return fail("Cascade deletion", Date.now() - start, requestIds, {
        stage: "cascade-replay", code: "replay_mismatch",
        message: `Replay returned ${JSON.stringify(replay)} vs original ${JSON.stringify(deleted)}`,
      });
    }

    try {
      await clientA.privateMemory.cascadeDelete({ userId: USER_A, messageIds: [ownRecord.id] }, key);
      return fail("Cascade deletion", Date.now() - start, requestIds, {
        stage: "cascade-conflict", code: "key_reuse_allowed",
        message: "Reusing the idempotency key with a changed payload should conflict",
      });
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (code !== "idempotency_conflict") {
        return fail("Cascade deletion", Date.now() - start, requestIds, {
          stage: "cascade-conflict", code: "wrong_error",
          message: `Expected idempotency_conflict, got ${code}: ${(err as Error).message}`,
        });
      }
      requestIds.push(`cascade-conflict`);
    }

    const freshRetry = await clientA.privateMemory.cascadeDelete(payload, `${runId}-cascade-key-2`);
    requestIds.push(`cascade-fresh-retry`);
    if (freshRetry.messagesRemoved !== 0 || freshRetry.linkedMemoriesRemoved !== 0 || freshRetry.embeddingsRemoved !== 0) {
      return fail("Cascade deletion", Date.now() - start, requestIds, {
        stage: "cascade-fresh-retry", code: "non_zero_retry", message: JSON.stringify(freshRetry),
      });
    }

    return pass("Cascade deletion", Date.now() - start, requestIds);
  } finally {
    await clientB.close();
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

export const scenarios: Array<{ name: string; fn: ScenarioFn }> = [
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
];
