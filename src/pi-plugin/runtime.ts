import { createPiClientConnection, type PiClientConnection } from "./client-connection.js";
import { createClientLifecycle, createDisabledLifecycle, type PiMemoryLifecycle } from "./client-lifecycle.js";
import type { ExecutionIdentity } from "../host-integration/types.js";
import { logInfo, logError } from "../mem-logger.js";

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

  let lifecycle: PiMemoryLifecycle;
  if (result.ok) {
    lifecycle = createClientLifecycle(connection, result.capabilities, "abmind-pi-plugin");
    logInfo(TAG, "Connected to abmind daemon via configured endpoint");
  } else {
    lifecycle = createDisabledLifecycle();
    logError(TAG, `Daemon unavailable (${result.code}) — memory disabled`);
  }

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
