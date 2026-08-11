import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
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

/** Seed the production sleep prompt set into a disposable acceptance home. */
export function seedSleepPrompts(repositoryRoot: string, abmindHome: string): void {
  const source = join(repositoryRoot, "templates", "prompts", "sleep");
  if (!existsSync(source)) {
    throw new Error(`Acceptance fixture sleep prompts missing: ${source}`);
  }
  cpSync(source, join(abmindHome, "prompts", "sleep"), { recursive: true });
}
