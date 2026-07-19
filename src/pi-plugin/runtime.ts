import { createPiClientConnection, type PiClientConnection } from "./client-connection.js";
import { createClientLifecycle, type PiMemoryLifecycle } from "./client-lifecycle.js";
import type { ExecutionIdentity } from "../host-integration/types.js";
import { logInfo, logWarn } from "../mem-logger.js";
import { VERSION as PI_CODING_AGENT_VERSION } from "@earendil-works/pi-coding-agent";

const TAG = "pi-plugin";

export interface PendingPiCapture {
  readonly generation: number;
  readonly prompt: string;
  readonly userTimestamp: number;
}

export interface PiRuntimeState {
  connection: PiClientConnection;
  lifecycle: PiMemoryLifecycle;
  identity: ExecutionIdentity | null;
  pendingWakeUp: string;
  pendingCapture: PendingPiCapture | null;
  captureGeneration: number;
  lastSettledCaptureGeneration: number;
  closed: boolean;
}

export interface PiRuntime {
  state: PiRuntimeState;
  close(): Promise<void>;
}

export async function createPiRuntime(): Promise<PiRuntime> {
  const connection = createPiClientConnection();

  const result = await connection.ensureReady();

  const lifecycle = createClientLifecycle(connection, "abmind-pi-plugin");
  if (result.ok) {
    logInfo(TAG, "Connected to abmind daemon via configured endpoint");
  } else {
    logWarn(TAG, `Daemon unavailable (${result.code}) — memory degraded`);
  }

  checkPiVersion();

  const state: PiRuntimeState = {
    connection,
    lifecycle,
    identity: null,
    pendingWakeUp: "",
    pendingCapture: null,
    captureGeneration: 0,
    lastSettledCaptureGeneration: -1,
    closed: false,
  };

  return {
    state,
    async close(): Promise<void> {
      if (state.closed) return;
      state.closed = true;
      await lifecycle.close().catch(() => {});
    },
  };
}

export function hasDegraded(runtime: PiRuntime): boolean {
  return runtime.state.connection.state.kind !== "ready";
}

export function beginCapture(state: PiRuntimeState, prompt: string): void {
  state.captureGeneration++;
  state.pendingCapture = { generation: state.captureGeneration, prompt, userTimestamp: Date.now() };
}

export function settleCapture(state: PiRuntimeState): void {
  if (!state.pendingCapture) return;
  state.lastSettledCaptureGeneration = state.pendingCapture.generation;
  state.pendingCapture = null;
}

export function resetCaptureState(state: PiRuntimeState): void {
  state.pendingWakeUp = "";
  state.pendingCapture = null;
  state.captureGeneration = 0;
  state.lastSettledCaptureGeneration = -1;
}

export function clearPendingCapture(state: PiRuntimeState): void {
  state.pendingCapture = null;
}

function checkPiVersion(): void {
  try {
    // Dynamic import so the peer package is only resolved at Pi runtime
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@earendil-works/pi-coding-agent") as { VERSION?: string };
    const detected = mod.VERSION;
    if (detected && typeof detected === "string") {
      const majorMinor = detected.split(".").slice(0, 2).join(".");
      if (majorMinor !== "0.80") {
        logWarn(TAG, `Pi ${detected} detected; abmind was tested against 0.80.x. Continuing optimistically.`);
      }
    }
  } catch {
    // Package not available (outside Pi runtime) — skip check
  }
}
