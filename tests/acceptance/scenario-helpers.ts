import type { AcceptanceFailure, ScenarioResult } from "./contracts.js";

export function pass(name: string, durationMs: number, requestIds: string[]): ScenarioResult {
  return { name, state: "passed", durationMs, requestIds };
}

export function fail(name: string, durationMs: number, requestIds: string[], failure: AcceptanceFailure): ScenarioResult {
  return { name, state: "failed", durationMs, requestIds, failure };
}

export function makeRequestIds(...ids: string[]): string[] {
  return ids;
}
