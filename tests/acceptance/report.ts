import { mkdirSync, copyFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import type { AcceptanceMatrixV1, LaneResult, ScenarioResult, AcceptanceFailure } from "./contracts.js";

const RESULT_DIR = "test-results/abmind-e2e";

function validateResultDir(root: string, runId: string): string {
  const dir = resolve(root, RESULT_DIR, runId);
  const rel = relative(resolve(root), dir);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Result directory ${dir} escapes repository root ${root}`);
  }
  return dir;
}

export function writeMatrix(root: string, matrix: AcceptanceMatrixV1): string {
  const dir = validateResultDir(root, matrix.runId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "matrix.json");
  writeFileSync(path, JSON.stringify(matrix, null, 2), "utf-8");
  return dir;
}

export function copyFailureArtifacts(root: string, runId: string, fixtureRoot: string, stage: string): string {
  const dir = validateResultDir(root, runId);
  const artifactDir = join(dir, "artifacts", stage);
  mkdirSync(artifactDir, { recursive: true });

  const logDir = join(fixtureRoot, "run");
  if (existsSync(logDir)) {
    for (const file of readdirSync(logDir)) {
      const src = join(logDir, file);
      if (statSync(src).isFile()) {
        copyFileSync(src, join(artifactDir, file));
      }
    }
  }

  return artifactDir;
}

function formatScenarioLine(s: ScenarioResult, i: number): string {
  const icon = s.state === "passed" ? "✓" : "✗";
  const time = `${s.durationMs}ms`;
  const detail = s.failure ? `  ${s.failure.code}: ${s.failure.message}` : "";
  return `  ${icon} ${i + 1}. ${s.name} (${time})${detail}`;
}

function formatLaneLine(l: LaneResult): string[] {
  const lines: string[] = [];
  if (l.state === "blocked") {
    lines.push(`  ⊘ ${l.transport} — blocked: ${l.blockedBy ?? "unknown"}`);
  } else {
    const pass = l.scenarios.filter(s => s.state === "passed").length;
    const fail = l.scenarios.filter(s => s.state === "failed").length;
    const total = l.scenarios.length;
    lines.push(`  ${fail === 0 ? "✓" : "✗"} ${l.transport} — ${pass}/${total} passed`);
    for (let i = 0; i < l.scenarios.length; i++) {
      const s = l.scenarios[i];
      if (s) lines.push(formatScenarioLine(s, i));
    }
  }
  return lines;
}

export function printHumanSummary(matrix: AcceptanceMatrixV1): void {
  const totalScenarios = matrix.lanes.reduce((acc, l) => {
    return acc + (l.state === "blocked" ? 0 : l.scenarios.length);
  }, 0);
  const passedScenarios = matrix.lanes.reduce((acc, l) => {
    return acc + (l.state !== "blocked" ? l.scenarios.filter(s => s.state === "passed").length : 0);
  }, 0);

  console.log(`\n═══ abmind E2E acceptance — ${matrix.runId} ═══`);
  console.log(`Duration: ${matrix.durationMs}ms  |  ${passedScenarios}/${totalScenarios} scenarios passed\n`);

  for (const lane of matrix.lanes) {
    for (const line of formatLaneLine(lane)) {
      console.log(line);
    }
    console.log("");
  }
}

export function printMachineLine(matrix: AcceptanceMatrixV1): void {
  const summary = {
    runId: matrix.runId,
    durationMs: matrix.durationMs,
    lanes: matrix.lanes.map(l => ({
      transport: l.transport,
      state: l.state,
      ...(l.blockedBy ? { blockedBy: l.blockedBy } : {}),
      ...(l.state !== "blocked" ? {
        passed: l.scenarios.filter(s => s.state === "passed").length,
        failed: l.scenarios.filter(s => s.state === "failed").length,
      } : {}),
    })),
  };
  console.log(`ABMIND_E2E_RESULT=${JSON.stringify(summary)}`);
}

export function computeExitCode(matrix: AcceptanceMatrixV1): number {
  for (const lane of matrix.lanes) {
    if (lane.state === "failed") return 1;
    for (const scenario of lane.scenarios) {
      if (scenario.state === "failed") return 1;
    }
  }
  return 0;
}

export function failedScenarios(lanes: LaneResult[]): ScenarioResult[] {
  const failed: ScenarioResult[] = [];
  for (const lane of lanes) {
    if (lane.state === "blocked") continue;
    for (const s of lane.scenarios) {
      if (s.state === "failed") failed.push(s);
    }
  }
  return failed;
}
