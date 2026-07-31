import type { AcceptanceFixture, ScenarioResult } from "./contracts.js";
import { pass, fail } from "./scenario-helpers.js";

const USER_A = "e2e-user-a";
const PROVIDER_ID = "e2e-test-provider";
const SLEEP_DEADLINE_MS = 45_000;

function responseForStep(stepId: string): string {
  if (stepId === "daily-summary") {
    return "- Deterministic Dreamy summary: the user made a stable technical decision.";
  }
  if (stepId === "extract-memories") return "0 memories stored";
  return "No changes.";
}

export async function sleepAndDreamy(
  fixture: AcceptanceFixture,
  runId: string,
): Promise<ScenarioResult> {
  const start = Date.now();
  const requestIds: string[] = [];
  const client = await fixture.createClient(USER_A);
  let leaseId: string | undefined;

  try {
    const token = `${runId}-sleep`;
    const store = await client.privateMemory.instantStore({
      userId: USER_A,
      contentEn: "Sleep dreamy test memory",
      contentOriginal: "Sleep dreamy test memory",
      memoryType: "fact",
      emotionScore: 0.5,
      keyword: token,
      createdBy: "e2e-test",
    }, token);
    requestIds.push("instantStore");

    if (!store.stored || !store.memoryId || !store.semanticRevision) {
      return fail("Sleep/Dreamy", Date.now() - start, requestIds, {
        stage: "store", code: "store_failed", message: JSON.stringify(store),
      });
    }

    await client.privateMemory.recordMessage({
      userId: USER_A,
      sessionId: `${runId}-sleep-session`,
      role: "user",
      content: "A deterministic Dreamy E2E message for sleep processing.",
      timestamp: Date.now(),
    }, `${runId}-sleep-message`);
    requestIds.push("recordMessage");

    const openResult = await client.sleep.runtime.open(PROVIDER_ID, `${runId}-runtime-open`);
    requestIds.push("runtime.open");
    if (openResult.status !== "ok" || !openResult.leaseId) {
      return fail("Sleep/Dreamy", Date.now() - start, requestIds, {
        stage: "runtime.open", code: "lease_failed", message: JSON.stringify(openResult),
      });
    }
    leaseId = openResult.leaseId;

    const startResult = await client.sleep.start("manual", "budget", true, `${runId}-sleep-start`);
    requestIds.push("sleep.start");
    if (startResult.status !== "accepted") {
      return fail("Sleep/Dreamy", Date.now() - start, requestIds, {
        stage: "sleep.start", code: "sleep_not_accepted", message: JSON.stringify(startResult),
      });
    }

    let terminal = false;
    while (Date.now() < start + SLEEP_DEADLINE_MS && !terminal) {
      const next = await client.sleep.runtime.next(leaseId, 1_000);
      requestIds.push("runtime.next");
      if (next.status === "lease_expired") {
        return fail("Sleep/Dreamy", Date.now() - start, requestIds, {
          stage: "runtime.next", code: "lease_expired", message: "Sleep runtime lease expired",
        });
      }
      if (next.status === "closed") {
        terminal = true;
        break;
      }
      if (next.completionRequest) {
        const completed = await client.sleep.runtime.complete(
          leaseId,
          next.completionRequest.completionId,
          responseForStep(next.completionRequest.stepId),
          `${runId}-complete-${next.completionRequest.completionId}`,
        );
        requestIds.push("runtime.complete");
        if (completed.status !== "ok") {
          return fail("Sleep/Dreamy", Date.now() - start, requestIds, {
            stage: "runtime.complete", code: "completion_rejected", message: JSON.stringify(completed),
          });
        }
      }
      const status = await client.sleep.status();
      requestIds.push("sleep.status");
      terminal = status.state === "terminal" || status.state === "idle";
    }

    if (!terminal) {
      return fail("Sleep/Dreamy", Date.now() - start, requestIds, {
        stage: "sleep.lifecycle", code: "sleep_timeout", message: "Sleep did not reach a terminal state",
      });
    }

    // Fixture-owned promotion: local invokes the CLI, remote calls the
    // equivalent public private.adjustRelevance method.
    try {
      await fixture.promoteMemory({
        principalId: USER_A,
        memoryId: store.memoryId,
        expectedRevision: store.semanticRevision,
        operationKey: `${runId}-sleep-promote`,
      });
    } catch (err) {
      return fail("Sleep/Dreamy", Date.now() - start, requestIds, {
        stage: "sleep-apply", code: "promotion_failed", message: (err as Error).message,
      });
    }
    requestIds.push("sleep-apply-promote");

    return pass("Sleep/Dreamy", Date.now() - start, requestIds);
  } finally {
    if (leaseId) await client.sleep.runtime.close(leaseId, `${runId}-runtime-close`).catch(() => {});
    await client.close();
  }
}
