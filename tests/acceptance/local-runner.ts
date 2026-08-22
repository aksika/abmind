import { resolve } from "node:path";
import { LocalDaemonFixture } from "./local-daemon-fixture.js";
import { RemoteWssFixture } from "./remote-wss-fixture.js";
import { scenarios } from "./private-memory-scenarios.js";
import { sleepAndDreamy } from "./sleep-runtime-driver.js";
import { runDaemonLifecycleLane } from "./daemon-lifecycle-driver.js";
import { writeMatrix, copyFailureArtifacts as copyReportArtifacts, printHumanSummary, printMachineLine, computeExitCode } from "./report.js";
import type { AcceptanceFixture, LaneResult, ScenarioResult, AcceptanceMatrixV1 } from "./contracts.js";

/**
 * #1382/#1528: consumer conformance is owned by the consumer. The abtars
 * production-composition runner (scripts/pi-production-e2e.ts) owns the
 * abtars probes and the route-contract conformance check. This runner only
 * owns abmind's own daemon/service acceptance lanes; a standalone abmind
 * checkout must build and run these lanes without locating a sibling abtars
 * checkout or writing any abtars-specific file.
 */

async function runLane(fixture: AcceptanceFixture, transport: "local-unix" | "remote-wss", runId: string): Promise<LaneResult> {
  const scenarioResults: ScenarioResult[] = [];

  for (const { name, fn } of scenarios) {
    try {
      const result = await fn(fixture, runId);
      result.requestIds = fixture.takeRequestIds();
      scenarioResults.push(result);
    } catch (err) {
      scenarioResults.push({
        name,
        state: "failed",
        durationMs: 0,
        requestIds: fixture.takeRequestIds(),
        failure: { stage: name, code: "uncaught", message: (err as Error).message },
      });
    }
  }

  try {
    const sleepResult = await sleepAndDreamy(fixture, runId);
    sleepResult.requestIds = fixture.takeRequestIds();
    scenarioResults.push(sleepResult);
  } catch (err) {
    scenarioResults.push({
      name: "Sleep/Dreamy",
      state: "failed",
      durationMs: 0,
      requestIds: fixture.takeRequestIds(),
      failure: { stage: "Sleep/Dreamy", code: "uncaught", message: (err as Error).message },
    });
  }

  const failed = scenarioResults.filter(r => r.state === "failed");
  const state = failed.length > 0 ? "failed" : "passed";

  return { transport, state, scenarios: scenarioResults };
}

async function main(): Promise<void> {
  const runId = `e2e-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const overallStart = Date.now();

  const localFixture = new LocalDaemonFixture();
  const remoteFixture = new RemoteWssFixture();
  const lanes: LaneResult[] = [];
  let localFailed = false;
  let remoteFailed = false;
  let abmindRoot = "";

  try {
    try {
      await localFixture.startOwner();
      console.log(`Local daemon started at ${localFixture.socketPath}`);
      const localLane = await runLane(localFixture, "local-unix", runId);
      lanes.push(localLane);
      localFailed = localLane.state === "failed";
      abmindRoot = resolve(localFixture.abmindRoot);
    } catch (err) {
      console.error("Local lane fatal:", err);
      lanes.push({ transport: "local-unix", state: "failed", scenarios: [] });
      localFailed = true;
    } finally {
      if (localFailed) {
        try {
          await localFixture.copyFailureArtifacts("e2e-failure");
          copyReportArtifacts(resolve(localFixture.abmindRoot), runId, localFixture.root, "e2e-failure");
        } catch (artifactErr) {
          console.error("Local failure artifact capture failed:", artifactErr);
        }
      }
      await localFixture.cleanup();
    }

    // #1701: dedicated process-level lifecycle lane — clean SIGTERM restart
    // and abrupt SIGKILL recovery on disposable fixtures.
    try {
      const lifecycleLane = await runDaemonLifecycleLane();
      lanes.push(lifecycleLane);
      localFailed = localFailed || lifecycleLane.state === "failed";
    } catch (err) {
      console.error("Lifecycle lane fatal:", err);
      lanes.push({ transport: "local-unix", state: "failed", scenarios: [] });
      localFailed = true;
    }

    try {
      await remoteFixture.startOwner();
      console.log(`Remote WSS daemon started on port ${remoteFixture.endpointPort}`);
      const remoteLane = await runLane(remoteFixture, "remote-wss", runId);
      lanes.push(remoteLane);
      remoteFailed = remoteLane.state === "failed";
      abmindRoot = resolve(remoteFixture.abmindRoot);
    } catch (err) {
      console.error("Remote lane fatal:", err);
      lanes.push({ transport: "remote-wss", state: "failed", scenarios: [] });
      remoteFailed = true;
    } finally {
      if (remoteFailed) {
        try {
          await remoteFixture.copyFailureArtifacts("e2e-failure");
          copyReportArtifacts(resolve(remoteFixture.abmindRoot), runId, remoteFixture.root, "e2e-failure");
        } catch (artifactErr) {
          console.error("Remote failure artifact capture failed:", artifactErr);
        }
      }
      await remoteFixture.cleanup();
    }
  } catch (err) {
    console.error("Fixture construction failed:", err);
    try { await localFixture.cleanup(); } catch { }
    try { await remoteFixture.cleanup(); } catch { }
    process.exitCode = 1;
    return;
  }

  const totalDuration = Date.now() - overallStart;

  const matrix: AcceptanceMatrixV1 = {
    schemaVersion: 1,
    runId,
    startedAt,
    durationMs: totalDuration,
    lanes,
  };

  if (localFailed || remoteFailed) {
    const stage = "e2e-failure";
    matrix.artifacts = { relativeDirectory: stage };
  }

  writeMatrix(abmindRoot || resolve(localFixture.abmindRoot), matrix);
  printHumanSummary(matrix);
  printMachineLine(matrix);

  process.exitCode = computeExitCode(matrix);
}

await main();
