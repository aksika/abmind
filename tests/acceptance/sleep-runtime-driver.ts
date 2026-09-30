import type { AcceptanceFixture, ScenarioResult } from "./contracts.js";
import { pass, fail } from "./scenario-helpers.js";

const USER_A = "e2e-user-a";
const PROVIDER_ID = "e2e-test-provider";
const SLEEP_DEADLINE_MS = 45_000;

function responseForStep(stepId: string, prompt?: string): string {
  if (stepId === "daily-summary") {
    return "- Deterministic Dreamy summary: the user made a stable technical decision.";
  }
  if (stepId === "gc-noise") {
    // #1807: GC selection is code-owned — the response must carry a JSON ID
    // array drawn from the offered set. The fixture holds no noise, so it
    // selects nothing; `[]` is the prompt's own canonical empty answer.
    return "[]";
  }
  if (stepId === "extract-memories") {
    // #1859: extraction is disposition-complete — every offered [src=N] id
    // needs a PROPOSE_STORE or DECLINE, or the step fails closed. Settle
    // every id from the completion prompt; the first carries one durable
    // fact so the #1653 review sees an extraction write.
    const ids = [...new Set(
      [...(prompt ?? "").matchAll(/\[src=(\d+)\]/g)]
        .map((m) => parseInt(m[1]!, 10))
        .filter((n) => Number.isSafeInteger(n)),
    )];
    if (ids.length === 0) return "2 memories stored";
    const [first, ...rest] = ids as [number, ...number[]];
    return [
      `PROPOSE_STORE srcmsg=${first} type=fact text="Deterministic Dreamy extraction: the user made a stable technical decision."`,
      ...rest.map((id) => `DECLINE srcmsg=${id} reason="fixture: no additional durable fact"`),
    ].join("\n");
  }
  return "No changes.";
}

interface SleepStatus {
  state: "idle" | "running" | "terminal" | "interrupted";
  last?: {
    runId?: string;
    attemptedAt: number;
    finishedAt?: number;
    status: string;
    resumable: boolean;
    completedSteps: number;
    failedSteps: number;
  };
}

/**
 * #1523: poll sleep.status() until the accepted run reaches a settled state.
 * Returns the settled status, or null when the run is still active.
 */
async function settleRunStatus(client: { sleep: { status(): Promise<SleepStatus> } }, acceptedRunId: string, waitMs = 5_000): Promise<SleepStatus | null> {
  const deadline = Date.now() + waitMs;
  let status: SleepStatus | null = null;
  while (Date.now() < deadline) {
    status = await client.sleep.status();
    if (status.state === "terminal" || status.state === "interrupted" || status.state === "idle") return status;
    await new Promise((r) => setTimeout(r, 200));
  }
  return status;
}

/**
 * #1523: the accepted run must have COMPLETED, not merely reached a terminal
 * state. A terminal lease revocation is the expected #1517 consequence of a
 * finished run; only an active run with a revoked lease is an infrastructure
 * failure.
 */
function validateCompletedRun(status: SleepStatus, acceptedRunId: string): { ok: boolean; detail: string } {
  if (status.state !== "terminal") {
    return { ok: false, detail: `state=${status.state}, expected terminal` };
  }
  if (status.last?.runId !== acceptedRunId) {
    return { ok: false, detail: `last.runId=${status.last?.runId}, expected ${acceptedRunId}` };
  }
  if (status.last?.status !== "completed") {
    return { ok: false, detail: `last.status=${status.last?.status}, expected completed` };
  }
  return { ok: true, detail: `runId=${acceptedRunId} status=${status.last.status}` };
}

export async function sleepAndDreamy(
  fixture: AcceptanceFixture,
  runId: string,
): Promise<ScenarioResult> {
  const start = Date.now();
  const requestIds: string[] = [];
  const client = await fixture.createClient(USER_A);
  let leaseId: string | undefined;
  let acceptedRunId: string | undefined;

  try {
    const token = `${runId}-sleep`;
    const store = await client.privateMemory.instantStore({
      userId: USER_A,
      contentEn: "Sleep dreamy test memory",
      contentOriginal: "Sleep dreamy test memory",
      memoryType: "fact",
      emotionScore: 0.5,
      // #1523: a non-anomalous seed. fixMemoryDefaults() repairs the legacy
      // trust=0/credibility=6/integrity=2 tuple during pre-sleep maintenance,
      // which would invalidate the CAS revision the promotion step relies on.
      trust: 2,
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

    // #1859: proposal-only steps (extract-memories and other consequential
    // writes) fail closed unless the leased runtime declares enforcement.
    // This fixture scripts every model response through runtime.complete —
    // no tools execute — so it declares the capability the host contract
    // requires, emulating a proposal-enforcing host. Production's
    // fail-closed gate is unchanged.
    const openResult = await client.sleep.runtime.open(PROVIDER_ID, `${runId}-runtime-open`, { proposalOnly: true });
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
    acceptedRunId = startResult.runId;

    let terminal = false;
    while (Date.now() < start + SLEEP_DEADLINE_MS && !terminal) {
      const next = await client.sleep.runtime.next(leaseId, 1_000);
      requestIds.push("runtime.next");
      if (next.status === "lease_expired") {
        // #1517: a settled run revokes the provider lease. Decide from the
        // coordinator's status: a run still active after the settle window
        // is a real lease failure; a settled run is the normal revocation.
        const settledStatus = await settleRunStatus(client, acceptedRunId!);
        if (settledStatus === null) {
          return fail("Sleep/Dreamy", Date.now() - start, requestIds, {
            stage: "runtime.next", code: "lease_expired",
            message: "Sleep runtime lease expired while the run is still active",
          });
        }
        terminal = true;
        break;
      }
      if (next.status === "closed") {
        terminal = true;
        break;
      }
      if (next.completionRequest) {
        // #1653: mirror the model's store tool calls — an extraction step that
        // reports success must actually create durable memories, or the
        // deterministic sleep review correctly fails the run.
        if (next.completionRequest.stepId === "extract-memories") {
          // Idempotency: the broker may redeliver a completion request, so
          // the mirror store under the fixed `${runId}-extract-store` key
          // must be byte-identical on retry. A Date.now() payload would hash
          // differently and trip the ledger's key-reuse conflict; runId
          // already scopes the key to this run.
          await client.privateMemory.instantStore({
            userId: USER_A,
            contentEn: `Sleep-extracted memory ${runId}`,
            contentOriginal: `Sleep-extracted memory ${runId}`,
            memoryType: "fact",
            emotionScore: 0.5,
            trust: 2,
            keyword: `${runId}-extracted`,
            createdBy: "e2e-sleep",
          }, `${runId}-extract-store`);
          requestIds.push("sleep-extract-store");
        }
        const completed = await client.sleep.runtime.complete(
          leaseId,
          next.completionRequest.completionId,
          responseForStep(next.completionRequest.stepId, next.completionRequest.prompt),
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

    // The run must have completed, not merely ended. A failed cycle (e.g. a
    // missing-prompt step failure) reaches terminal too; only a completed
    // run may proceed to the promotion assertion.
    const settled = await settleRunStatus(client, acceptedRunId!);
    const completed = settled === null
      ? { ok: false, detail: "no settled status observed" }
      : validateCompletedRun(settled, acceptedRunId!);
    if (!completed.ok) {
      return fail("Sleep/Dreamy", Date.now() - start, requestIds, {
        stage: "sleep.lifecycle", code: "sleep_not_completed",
        message: `Sleep run did not complete: ${completed.detail}`,
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
