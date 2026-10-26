import { LocalTransport } from "../../src/index.js";
import { LocalDaemonFixture } from "./local-daemon-fixture.js";
import type { LaneResult, ScenarioResult } from "./contracts.js";

/**
 * #1701: process-level daemon lifecycle acceptance.
 *
 * Two deliberately separate scenarios:
 *
 * - Clean restart: SIGTERM with one bounded request in flight must exit
 *   gracefully WITHOUT SIGKILL, and the owner lease + Unix socket must be
 *   absent BEFORE any replacement starts. Checking artifacts before
 *   replacement is what prevents #1700's stale recovery from masking a dirty
 *   shutdown.
 * - Abrupt/reboot-style recovery: SIGKILL leaves stale artifacts; a
 *   replacement must recover them through normal startup (#1700) and reach
 *   health with a new instance ID.
 */

const LONG_POLL_WAIT_MS = 2_500;
const ADMISSION_SETTLE_MS = 300;

async function captureInstanceId(fixture: LocalDaemonFixture): Promise<string> {
  return fixture.captureInstanceId();
}

async function cleanRestartScenario(): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const fixture = new LocalDaemonFixture();
  try {
    await fixture.startOwner();
    const oldInstanceId = await captureInstanceId(fixture);

    // One deterministic bounded request in flight while SIGTERM arrives.
    const transport = new LocalTransport(fixture.socketPath);
    const longPoll = transport.request({
      version: 1,
      requestId: "lifecycle-long-poll",
      method: "sleep.events",
      payload: { afterSeq: 999_999, limit: 1, waitMs: LONG_POLL_WAIT_MS },
    });
    await new Promise((r) => setTimeout(r, ADMISSION_SETTLE_MS));

    const exit = await fixture.sigtermOwner();

    // No SIGKILL fallback: the daemon must finish its own bounded cleanup.
    if (exit.signal !== null) throw new Error(`Daemon died on signal ${exit.signal} — cleanup did not finish gracefully`);
    if (exit.exitCode !== 0) throw new Error(`Daemon exited ${exit.exitCode}, expected clean exit 0`);

    // The accepted request's response must have been flushed before exit.
    const pollResponse = await longPoll;
    if (!pollResponse.ok) throw new Error(`In-flight request did not complete during drain: ${JSON.stringify(pollResponse).slice(0, 200)}`);
    await transport.close();

    // Artifact absence BEFORE replacement startup — replacement health alone
    // would be masked by #1700 stale recovery.
    if (fixture.ownerLeaseExists()) throw new Error("Owner lease still exists after clean shutdown");
    if (fixture.socketExists()) throw new Error("Unix socket still exists after clean shutdown");

    // Replacement on the same DB/socket: healthy, new instance, and no
    // evidence of owner-wait retries or stale-endpoint recovery.
    await fixture.startOwner();
    const newInstanceId = await captureInstanceId(fixture);
    if (newInstanceId === oldInstanceId) throw new Error("Replacement reports the old instance ID");
    const logs = fixture.logTail();
    if (logs.includes("Owner lease not available")) throw new Error("Replacement hit an owner-wait retry — shutdown was not clean");
    if (logs.includes("Removing stale endpoint")) throw new Error("Replacement found a stale socket — shutdown was not clean");

    // Cleanly stop the replacement: final artifact absence.
    const replacementExit = await fixture.sigtermOwner();
    if (replacementExit.signal !== null || replacementExit.exitCode !== 0) {
      throw new Error(`Replacement stop was not clean: ${JSON.stringify(replacementExit)}`);
    }
    if (fixture.ownerLeaseExists() || fixture.socketExists()) {
      throw new Error("Artifacts remain after cleanly stopping the replacement");
    }

    return { name: "Daemon lifecycle: clean SIGTERM restart", state: "passed", durationMs: Date.now() - startedAt, requestIds: [] };
  } catch (err) {
    return {
      name: "Daemon lifecycle: clean SIGTERM restart",
      state: "failed",
      durationMs: Date.now() - startedAt,
      requestIds: [],
      failure: { stage: "clean-restart", code: "uncaught", message: (err as Error).message },
    };
  } finally {
    await fixture.cleanup().catch(() => {});
  }
}

async function abruptRecoveryScenario(): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const fixture = new LocalDaemonFixture();
  try {
    await fixture.startOwner();
    const oldInstanceId = await captureInstanceId(fixture);

    await fixture.sigkillOwner();

    // Crash precondition: stale lease AND stale socket remain on disk.
    if (!fixture.ownerLeaseExists()) throw new Error("SIGKILL did not leave a stale owner lease behind");
    if (!fixture.socketExists()) throw new Error("SIGKILL did not leave a stale socket behind");

    // Replacement must recover the dead-owner artifacts through normal
    // startup (#1700) and reach health with a fresh instance ID.
    await fixture.startOwner();
    const newInstanceId = await captureInstanceId(fixture);
    if (newInstanceId === oldInstanceId) throw new Error("Replacement reports the old instance ID after abrupt recovery");
    if (fixture.logTail().includes("Owner lease not available")) {
      throw new Error("Replacement waited on a dead owner — stale takeover did not proceed");
    }

    // Cleanly stop the replacement and assert final artifact absence.
    const exit = await fixture.sigtermOwner();
    if (exit.signal !== null || exit.exitCode !== 0) {
      throw new Error(`Replacement clean stop was not graceful: ${JSON.stringify(exit)}`);
    }
    if (fixture.ownerLeaseExists() || fixture.socketExists()) {
      throw new Error("Artifacts remain after cleanly stopping the recovered replacement");
    }

    return { name: "Daemon lifecycle: abrupt SIGKILL recovery", state: "passed", durationMs: Date.now() - startedAt, requestIds: [] };
  } catch (err) {
    return {
      name: "Daemon lifecycle: abrupt SIGKILL recovery",
      state: "failed",
      durationMs: Date.now() - startedAt,
      requestIds: [],
      failure: { stage: "abrupt-recovery", code: "uncaught", message: (err as Error).message },
    };
  } finally {
    await fixture.cleanup().catch(() => {});
  }
}

export async function runDaemonLifecycleLane(): Promise<LaneResult> {
  const scenarios: ScenarioResult[] = [];
  scenarios.push(await cleanRestartScenario());
  scenarios.push(await abruptRecoveryScenario());
  const failed = scenarios.filter((s) => s.state === "failed");
  return { transport: "local-unix", state: failed.length > 0 ? "failed" : "passed", scenarios };
}
