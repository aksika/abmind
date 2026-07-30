import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { LocalDaemonFixture } from "./local-daemon-fixture.js";
import { scenarios } from "./private-memory-scenarios.js";
import { sleepAndDreamy, type SleepFixtureInfo } from "./sleep-runtime-driver.js";
import { writeMatrix, copyFailureArtifacts as copyReportArtifacts, printHumanSummary, printMachineLine, computeExitCode, failedScenarios } from "./report.js";
import type { LaneResult, ScenarioResult, AcceptanceMatrixV1 } from "./contracts.js";

async function runLocalLane(fixture: LocalDaemonFixture, runId: string): Promise<LaneResult> {
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

  const sleepInfo: SleepFixtureInfo = {
    root: fixture.root,
    homeDir: fixture.homeDir,
    socketPath: fixture.socketPath,
    memoryDir: fixture.memoryDir,
    abmindRoot: fixture.abmindRoot,
  };

  try {
    const sleepResult = await sleepAndDreamy(fixture, sleepInfo, runId);
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

  return { transport: "local-unix", state, scenarios: scenarioResults };
}

async function runAbtarsProbe(fixture: LocalDaemonFixture, runId: string): Promise<LaneResult> {
  const siblingProbe = resolve(fixture.abmindRoot, "../abtars/scripts/abmind-local-e2e-probe.ts");
  const abtarsRoot = resolve(fixture.abmindRoot, "../abtars");

  const tsxBin = resolve(abtarsRoot, "node_modules/.bin/tsx");
  if (!existsSync(abtarsRoot) || !existsSync(siblingProbe) || !existsSync(tsxBin)) {
    const reason = !existsSync(abtarsRoot) ? "sibling abtars repository not found"
      : !existsSync(siblingProbe) ? "abmind-local-e2e-probe.ts not found"
      : "tsx not installed in abtars (run npm ci)";
    return {
      transport: "abtars-local-consumer",
      state: "blocked",
      blockedBy: `standalone checkout — ${reason}`,
      scenarios: [],
    };
  }

  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(tsxBin, [
    siblingProbe,
    "--socket", fixture.socketPath,
    "--run-id", runId,
  ], {
    cwd: abtarsRoot,
    env: {
      ...fixture.probeEnv(),
      ABMIND_E2E_DISPOSABLE_USER: "e2e-probe-user",
    },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: 20_000,
    maxBuffer: 512 * 1024,
  });

  if (result.status !== 0) {
    return {
      transport: "abtars-local-consumer",
      state: "failed",
      scenarios: [{
        name: "abtars consumer probe",
        state: "failed",
        durationMs: 0,
        requestIds: fixture.takeRequestIds(),
        failure: { stage: "probe", code: "non_zero_exit", message: result.stderr?.slice(-1000) ?? "unknown" },
      }],
    };
  }

  return {
    transport: "abtars-local-consumer",
    state: "passed",
    scenarios: [{
      name: "abtars consumer probe",
      state: "passed",
      durationMs: 0,
      requestIds: fixture.takeRequestIds(),
    }],
  };
}

async function main(): Promise<void> {
  const runId = `e2e-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const overallStart = Date.now();

  const fixture = new LocalDaemonFixture();

  try {
    await fixture.startOwner();
    console.log(`Daemon started at ${fixture.socketPath}`);

    const localLane = await runLocalLane(fixture, runId);
    const abtarsLane = await runAbtarsProbe(fixture, runId);

    const remoteLane: LaneResult = {
      transport: "remote-wss",
      state: "blocked",
      blockedBy: "#1508 — signed-WSS endpoint selection not yet implemented",
      scenarios: [],
    };

    const totalDuration = Date.now() - overallStart;

    const matrix: AcceptanceMatrixV1 = {
      schemaVersion: 1,
      runId,
      startedAt,
      durationMs: totalDuration,
      lanes: [localLane, remoteLane, abtarsLane],
    };

    const failed = failedScenarios(matrix.lanes);
    if (failed.length > 0) {
      await fixture.copyFailureArtifacts("e2e-failure");
      const abmindRoot = resolve(fixture.abmindRoot);
      copyReportArtifacts(abmindRoot, runId, fixture.root, "e2e-failure");
      matrix.artifacts = { relativeDirectory: "e2e-failure" };
    }

    const abmindRoot = resolve(fixture.abmindRoot);
    writeMatrix(abmindRoot, matrix);
    printHumanSummary(matrix);
    printMachineLine(matrix);

    exitCode = computeExitCode(matrix);
  } catch (err) {
    console.error("Fatal runner error:", err);
    await fixture.copyFailureArtifacts("fatal-error");
    const abmindRoot = resolve(fixture.abmindRoot);
    copyReportArtifacts(abmindRoot, runId, fixture.root, "fatal-error");
    exitCode = 1;
  } finally {
    await fixture.cleanup();
  }

  process.exitCode = exitCode;
}

let exitCode = 1;
await main();
