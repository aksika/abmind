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
  transport: "local-unix" | "remote-wss" | "abtars-local-consumer" | "abtars-remote-consumer";
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

export interface PromoteMemoryInput {
  principalId: string;
  memoryId: number;
  expectedRevision: number;
  operationKey: string;
}

export interface AcceptanceFixture {
  readonly transport: "local-unix" | "remote-wss";
  readonly root: string;
  /**
   * True when the fixture's transport enforces per-peer grants. The local
   * Unix lane has no grant model, so grant-denial scenarios only assert
   * denial semantics on fixtures that enforce grants.
   */
  readonly grantEnforcement: boolean;
  createClient(principalId?: string): Promise<import("abmind").AbmindClient>;
  /** Fixture-owned sleep promotion: local invokes the CLI, remote calls the public adjustRelevance method. */
  promoteMemory(input: PromoteMemoryInput): Promise<void>;
  takeRequestIds(): string[];
  probeEnv(): NodeJS.ProcessEnv;
  stopOwner(): Promise<void>;
  startOwner(): Promise<void>;
  copyFailureArtifacts(stage: string): Promise<string>;
}
