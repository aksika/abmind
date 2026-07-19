import type { MemoryConfig } from "../memory-config.js";
import { loadMemoryConfig } from "../memory-config.js";
import { AbmindClient } from "../abmind-client.js";
import { LocalTransport } from "../local-transport.js";
import type { HostMemoryLifecycle } from "../host-integration/lifecycle.js";
import { logError, logInfo } from "../mem-logger.js";
import type { ExecutionIdentity } from "../host-integration/types.js";
import { join } from "node:path";
import { abmindHome } from "../mem-paths.js";

const TAG = "pi-plugin";

export interface PendingPiCapture {
  readonly generation: number;
  readonly prompt: string;
}

export interface PiRuntimeState {
  client: AbmindClient | null;
  lifecycle: HostMemoryLifecycle | null;
  identity: ExecutionIdentity | null;
  pendingWakeUp: string;
  pendingCapture: PendingPiCapture | null;
  captureGeneration: number;
  lastSettledCaptureGeneration: number;
  closed: boolean;
}

export interface PiRuntime {
  state: PiRuntimeState;
  close(): void;
}

export async function createPiRuntime(_memoryConfig?: Partial<MemoryConfig>): Promise<PiRuntime> {
  let client: AbmindClient | null = null;

  try {
    const socketPath = join(abmindHome(), "run", "abmind.sock");
    const transport = new LocalTransport(socketPath);
    client = new AbmindClient(transport);
    await client.negotiate();
    logInfo(TAG, "Connected to abmind daemon via LocalTransport");
  } catch (err) {
    logError(TAG, `Daemon unavailable — running degraded: ${(err as Error).message}`);
  }

  const state: PiRuntimeState = {
    client,
    lifecycle: null,
    identity: null,
    pendingWakeUp: "",
    pendingCapture: null,
    captureGeneration: 0,
    lastSettledCaptureGeneration: -1,
    closed: false,
  };

  return {
    state,
    close(): void {
      if (state.closed) return;
      state.closed = true;
      client?.close().catch(() => {});
    },
  };
}

export function hasDegraded(runtime: PiRuntime): boolean {
  return runtime.state.client === null;
}

export function beginCapture(state: PiRuntimeState, prompt: string): void {
  state.captureGeneration++;
  state.pendingCapture = { generation: state.captureGeneration, prompt };
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
