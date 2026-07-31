import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { LocalDaemonFixture } from "./local-daemon-fixture.js";
import { RemoteWssFixture } from "./remote-wss-fixture.js";
import { scenarios } from "./private-memory-scenarios.js";
import { sleepAndDreamy } from "./sleep-runtime-driver.js";
import { writeMatrix, copyFailureArtifacts as copyReportArtifacts, printHumanSummary, printMachineLine, computeExitCode } from "./report.js";
import type { AcceptanceFixture, LaneResult, ScenarioResult, AcceptanceMatrixV1 } from "./contracts.js";

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

interface AbtarsProbeInfo {
  laneName: "abtars-local-consumer" | "abtars-remote-consumer";
  label: string;
  abtarsRoot: string;
  probeScript: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  runId: string;
}

async function runAbtarsProbe(info: AbtarsProbeInfo): Promise<LaneResult> {
  const tsxBin = resolve(info.abtarsRoot, "node_modules/.bin/tsx");
  if (!existsSync(info.abtarsRoot) || !existsSync(info.probeScript) || !existsSync(tsxBin)) {
    const reason = !existsSync(info.abtarsRoot) ? "sibling abtars repository not found"
      : !existsSync(info.probeScript) ? `${info.label} probe script not found`
      : "tsx not installed in abtars (run npm ci)";
    return {
      transport: info.laneName,
      state: "blocked",
      blockedBy: `standalone checkout — ${reason}`,
      scenarios: [],
    };
  }

  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(tsxBin, [info.probeScript, ...info.args], {
    cwd: info.abtarsRoot,
    env: info.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: 512 * 1024,
  });

  if (result.status !== 0) {
    return {
      transport: info.laneName,
      state: "failed",
      scenarios: [{
        name: info.label,
        state: "failed",
        durationMs: 0,
        requestIds: [],
        failure: { stage: "probe", code: "non_zero_exit", message: result.stderr?.slice(-1000) ?? "unknown" },
      }],
    };
  }

  return {
    transport: info.laneName,
    state: "passed",
    scenarios: [{
      name: info.label,
      state: "passed",
      durationMs: 0,
      requestIds: [],
    }],
  };
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

      const abtarsRoot = resolve(localFixture.abmindRoot, "../abtars");
      const localProbe = await runAbtarsProbe({
        laneName: "abtars-local-consumer",
        label: "abtars consumer probe (local Unix)",
        abtarsRoot,
        probeScript: resolve(abtarsRoot, "scripts/abmind-local-e2e-probe.ts"),
        args: ["--socket", localFixture.socketPath, "--run-id", runId],
        env: {
          ...localFixture.probeEnv(),
          ABMIND_E2E_DISPOSABLE_USER: "e2e-probe-user",
        },
        runId,
      });
      lanes.push(localProbe);
      localFailed = localFailed || localProbe.state === "failed";
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

    try {
      await remoteFixture.startOwner();
      console.log(`Remote WSS daemon started on port ${remoteFixture.endpointPort}`);
      const remoteLane = await runLane(remoteFixture, "remote-wss", runId);
      lanes.push(remoteLane);
      remoteFailed = remoteLane.state === "failed";

      const abtarsRoot = resolve(remoteFixture.abmindRoot, "../abtars");
      const remoteProbe = await runAbtarsProbe({
        laneName: "abtars-remote-consumer",
        label: "abtars consumer probe (signed WSS)",
        abtarsRoot,
        probeScript: resolve(abtarsRoot, "scripts/abmind-remote-e2e-probe.ts"),
        args: ["--home", remoteFixture.abtarsHomeDir, "--run-id", runId],
        env: remoteFixture.probeEnv(),
        runId,
      });
      lanes.push(remoteProbe);
      remoteFailed = remoteFailed || remoteProbe.state === "failed";
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
