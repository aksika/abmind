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
  transport: "local-unix" | "remote-wss";
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
  /**
   * #1658: seed a legacy extracted-memory row directly in the owner DB,
   * bypassing the Master-only creation gate (as pre-policy data exists).
   * Used to prove owner isolation without a foreign creation path.
   */
  seedMemory(input: { userId: string; contentEn: string; contentOriginal: string }): Promise<void>;
  /** Fixture-owned sleep promotion: local invokes the CLI, remote calls the public adjustRelevance method. */
  promoteMemory(input: PromoteMemoryInput): Promise<void>;
  takeRequestIds(): string[];
  stopOwner(): Promise<void>;
  startOwner(): Promise<void>;
  /**
   * #1382 route-loss fault control: stop and restart the owner on the SAME
   * endpoint (Unix socket path or WSS port) so clients observe a route drop
   * and recover through reconnect + renegotiation.
   */
  restartOwner(): Promise<void>;
  copyFailureArtifacts(stage: string): Promise<string>;
  /** Stop the owner and remove the disposable fixture root (idempotent). */
  cleanup(): Promise<void>;
}

// ── #1528: consumer fixture controller protocol (V1) ────────────────────────
//
// A process-neutral, consumer-agnostic control surface over a disposable
// abmind owner. The abtars production-composition harness (and any future
// consumer) spawns the compiled controller, reads one descriptor line, then
// exchanges newline-delimited JSON commands on stdin/stdout. The controller
// never imports a consumer package, never creates a consumer home, and never
// writes a consumer-specific config file.

export type FixtureLane = "local-unix" | "remote-wss";

export type FixtureConnectionDescriptor =
  | {
      mode: "local";
      socketPath: string;
    }
  | {
      mode: "wss";
      url: string;
      peerId: string;
      /** Absolute path to the generated Ed25519 signing key (contents never on stdout). */
      signingKeyPath: string;
      serverCertSha256: string;
    };

export interface ConsumerFixtureDescriptorV1 {
  version: 1;
  lane: FixtureLane;
  runId: string;
  principalId: string;
  connection: FixtureConnectionDescriptor;
  /** Stable, secret-free identifier for the generated endpoint (used in results). */
  endpointFingerprint: string;
}

export type FixtureCommandV1 =
  | { version: 1; id: string; command: "describe" }
  | { version: 1; id: string; command: "stopOwner" }
  | { version: 1; id: string; command: "startOwner" }
  | { version: 1; id: string; command: "restartOwner" }
  | { version: 1; id: string; command: "copyFailureArtifacts"; stage: string }
  | { version: 1; id: string; command: "conversationRows"; userId: string; since: number; limit: number }
  | { version: 1; id: string; command: "seedMemory"; userId: string; contentEn: string; contentOriginal: string }
  | { version: 1; id: string; command: "shutdown" };

export interface FixtureCommandError {
  code: string;
  message: string;
}

export type FixtureResponseV1 =
  | { version: 1; id: string; ok: true; result?: unknown }
  | { version: 1; id: string; ok: false; failure: AcceptanceFailure };

export interface FixtureDescriptorLineV1 {
  type: "descriptor";
  version: 1;
  descriptor: ConsumerFixtureDescriptorV1;
}

export const CONSUMER_FIXTURE_PROTOCOL_VERSION = 1;
export const FIXTURE_COMMAND_ID_MAX = 128;
export const FIXTURE_COMMAND_BYTES_MAX = 64 * 1024;
export const FIXTURE_CONVERSATION_ROWS_MAX = 200;
export const FIXTURE_STAGE_MAX = 128;
export const FIXTURE_USER_ID_MAX = 256;
export const FIXTURE_CONTENT_MAX = 4096;

/**
 * Parse and validate one controller command line. Returns the command or a
 * bounded rejection reason. Never throws for malformed input.
 */
export function parseFixtureCommand(raw: unknown): { ok: true; command: FixtureCommandV1 } | { ok: false; error: FixtureCommandError } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: { code: "malformed", message: "command must be a JSON object" } };
  }
  const rec = raw as Record<string, unknown>;
  if (rec["version"] !== CONSUMER_FIXTURE_PROTOCOL_VERSION) {
    return { ok: false, error: { code: "unsupported_version", message: `unsupported protocol version ${JSON.stringify(rec["version"])}` } };
  }
  if (typeof rec["id"] !== "string" || rec["id"].length === 0 || rec["id"].length > FIXTURE_COMMAND_ID_MAX) {
    return { ok: false, error: { code: "malformed", message: "command id must be a bounded non-empty string" } };
  }
  const command = rec["command"];
  const id = rec["id"] as string;
  switch (command) {
    case "describe":
    case "stopOwner":
    case "startOwner":
    case "restartOwner":
    case "shutdown":
      return { ok: true, command: { version: CONSUMER_FIXTURE_PROTOCOL_VERSION, id, command } };
    case "copyFailureArtifacts": {
      if (typeof rec["stage"] !== "string" || rec["stage"].length === 0 || rec["stage"].length > FIXTURE_STAGE_MAX) {
        return { ok: false, error: { code: "malformed", message: "stage must be a bounded non-empty string" } };
      }
      return { ok: true, command: { version: CONSUMER_FIXTURE_PROTOCOL_VERSION, id, command, stage: rec["stage"] } };
    }
    case "conversationRows": {
      if (typeof rec["userId"] !== "string" || rec["userId"].length === 0 || rec["userId"].length > FIXTURE_USER_ID_MAX) {
        return { ok: false, error: { code: "malformed", message: "userId must be a bounded non-empty string" } };
      }
      if (typeof rec["since"] !== "number" || !Number.isSafeInteger(rec["since"]) || rec["since"] < 0) {
        return { ok: false, error: { code: "malformed", message: "since must be a non-negative safe integer" } };
      }
      if (typeof rec["limit"] !== "number" || !Number.isSafeInteger(rec["limit"]) || rec["limit"] < 1 || rec["limit"] > FIXTURE_CONVERSATION_ROWS_MAX) {
        return { ok: false, error: { code: "malformed", message: `limit must be 1..${FIXTURE_CONVERSATION_ROWS_MAX}` } };
      }
      return { ok: true, command: { version: CONSUMER_FIXTURE_PROTOCOL_VERSION, id, command, userId: rec["userId"], since: rec["since"], limit: rec["limit"] } };
    }
    case "seedMemory": {
      if (typeof rec["userId"] !== "string" || rec["userId"].length === 0 || rec["userId"].length > FIXTURE_USER_ID_MAX) {
        return { ok: false, error: { code: "malformed", message: "userId must be a bounded non-empty string" } };
      }
      if (typeof rec["contentEn"] !== "string" || rec["contentEn"].length === 0 || rec["contentEn"].length > FIXTURE_CONTENT_MAX) {
        return { ok: false, error: { code: "malformed", message: "contentEn must be a bounded non-empty string" } };
      }
      const contentOriginal = typeof rec["contentOriginal"] === "string" ? rec["contentOriginal"] : rec["contentEn"];
      return { ok: true, command: { version: CONSUMER_FIXTURE_PROTOCOL_VERSION, id, command, userId: rec["userId"], contentEn: rec["contentEn"], contentOriginal } };
    }
    default:
      return { ok: false, error: { code: "unknown_command", message: `unknown command ${JSON.stringify(command)}` } };
  }
}

/** Validate a consumer fixture descriptor produced by the controller. */
export function parseConsumerFixtureDescriptor(raw: unknown): { ok: true; descriptor: ConsumerFixtureDescriptorV1 } | { ok: false; error: FixtureCommandError } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: { code: "malformed", message: "descriptor must be a JSON object" } };
  }
  const rec = raw as Record<string, unknown>;
  if (rec["version"] !== 1 || rec["lane"] !== "local-unix" && rec["lane"] !== "remote-wss") {
    return { ok: false, error: { code: "malformed", message: "descriptor lane/version invalid" } };
  }
  if (typeof rec["runId"] !== "string" || rec["runId"].length === 0 || rec["runId"].length > 128) {
    return { ok: false, error: { code: "malformed", message: "descriptor runId invalid" } };
  }
  if (typeof rec["principalId"] !== "string" || rec["principalId"].length === 0 || rec["principalId"].length > FIXTURE_USER_ID_MAX) {
    return { ok: false, error: { code: "malformed", message: "descriptor principalId invalid" } };
  }
  if (typeof rec["endpointFingerprint"] !== "string" || rec["endpointFingerprint"].length === 0 || rec["endpointFingerprint"].length > 128) {
    return { ok: false, error: { code: "malformed", message: "descriptor endpointFingerprint invalid" } };
  }
  const conn = rec["connection"] as Record<string, unknown> | null;
  if (conn === null || typeof conn !== "object" || Array.isArray(conn)) {
    return { ok: false, error: { code: "malformed", message: "descriptor connection invalid" } };
  }
  if (conn["mode"] === "local") {
    if (typeof conn["socketPath"] !== "string" || conn["socketPath"].length === 0) {
      return { ok: false, error: { code: "malformed", message: "descriptor local socketPath invalid" } };
    }
  } else if (conn["mode"] === "wss") {
    if (typeof conn["url"] !== "string" || typeof conn["peerId"] !== "string" || typeof conn["signingKeyPath"] !== "string" || typeof conn["serverCertSha256"] !== "string") {
      return { ok: false, error: { code: "malformed", message: "descriptor wss fields invalid" } };
    }
  } else {
    return { ok: false, error: { code: "malformed", message: `descriptor connection mode ${JSON.stringify(conn["mode"])} invalid` } };
  }
  const descriptor: ConsumerFixtureDescriptorV1 = {
    version: 1,
    lane: rec["lane"] as FixtureLane,
    runId: rec["runId"] as string,
    principalId: rec["principalId"] as string,
    connection: conn as FixtureConnectionDescriptor,
    endpointFingerprint: rec["endpointFingerprint"] as string,
  };
  return { ok: true, descriptor };
}
