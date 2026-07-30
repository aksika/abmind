export type LaneState = "passed" | "failed" | "blocked";

export interface AcceptanceFailure {
  stage: string;
  code: string;
  message: string;
}

export interface ScenarioResult {
  name: string;
  state: Exclude<LaneState, "blocked">;
  durationMs: number;
  requestIds: string[];
  failure?: AcceptanceFailure;
}

export interface LaneResult {
  transport: "local-unix" | "remote-wss" | "abtars-local-consumer";
  state: LaneState;
  blockedBy?: string;
  scenarios: ScenarioResult[];
}

export interface AcceptanceMatrixV1 {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  durationMs: number;
  lanes: LaneResult[];
  artifacts?: { relativeDirectory: string };
}

export interface AcceptanceFixture {
  readonly transport: "local-unix" | "remote-wss";
  readonly root: string;
  createClient(): Promise<import("abmind").AbmindClient>;
  takeRequestIds(): string[];
  probeEnv(): NodeJS.ProcessEnv;
  stopOwner(): Promise<void>;
  startOwner(): Promise<void>;
  copyFailureArtifacts(stage: string): Promise<string>;
}
