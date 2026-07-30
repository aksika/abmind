import type { AbmindClient } from "abmind";
import type { AcceptanceFixture, ScenarioResult } from "./contracts.js";
import { pass, fail } from "./scenario-helpers.js";

const USER_A = "e2e-user-a";
const USER_B = "e2e-user-b";

type ScenarioFn = (fixture: AcceptanceFixture, runId: string) => Promise<ScenarioResult>;

// ISO 8601 constant for validTo tests
const FUTURE_DATE = "2099-12-31";

const LIVE_CAPABILITY_METHODS = [
  "private.instantStore",
  "private.edit",
  "private.reclassify",
  "private.adjustRelevance",
  "private.merge",
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

    if (caps.methods.includes("private.cascadeDelete")) {
      return fail("Lifecycle and capabilities", Date.now() - start, [], {
        stage: "cascadeDelete", code: "unexpected_cascade",
        message: "private.cascadeDelete should not be enabled before #1511",
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
  const client = await fixture.createClient();

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
  const client = await fixture.createClient();

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
  const clientA = await fixture.createClient();
  const clientB = await fixture.createClient();

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
  const clientA = await fixture.createClient();

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

    await clientA.privateMemory.instantStore({
      userId: USER_B,
      contentEn: "User B's private memory",
      contentOriginal: "User B's private memory",
      memoryType: "fact",
      emotionScore: 0.5,
      keyword: tokenB,
      createdBy: "e2e-test",
    }, tokenB);
    requestIds.push(`store-B`);

    const aMemId = storeA.memoryId;
    const aRev = storeA.semanticRevision;

    const mutations: Array<{ name: string; call: () => Promise<{ ok: boolean }> }> = [
      {
        name: "edit",
        call: () => clientA.privateMemory.editMemory({
          userId: USER_B, memoryId: aMemId, expectedRevision: aRev,
          contentEn: "User B tries to edit A's memory",
        }),
      },
      {
        name: "reclassify",
        call: () => clientA.privateMemory.reclassifyMemory({
          userId: USER_B, memoryId: aMemId, expectedRevision: aRev, classification: 2,
        }),
      },
      {
        name: "adjustRelevance",
        call: () => clientA.privateMemory.adjustRelevance({
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
    const recallB = await clientA.privateMemory.recall({
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
    await clientA.close();
  }
};

export const idempotency: ScenarioFn = async (fixture, runId) => {
  const start = Date.now();
  const requestIds: string[] = [];
  const client = await fixture.createClient();

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
  const client = await fixture.createClient();

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

export const scenarios: Array<{ name: string; fn: ScenarioFn }> = [
  { name: "Lifecycle and capabilities", fn: lifecycleCapabilities },
  { name: "Store and recall", fn: storeAndRecall },
  { name: "Semantic mutation chain", fn: semanticMutationChain },
  { name: "Two-client stale race", fn: twoClientStaleRace },
  { name: "Owner isolation", fn: ownerIsolation },
  { name: "Idempotency", fn: idempotency },
  { name: "Restart durability", fn: restartDurability },
];
