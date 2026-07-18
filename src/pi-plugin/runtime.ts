import type { MemoryConfig } from "../memory-config.js";
import { loadMemoryConfig } from "../memory-config.js";
import { MemoryManager } from "../memory-manager.js";
import { logError, logInfo, logWarn } from "../mem-logger.js";
import { HostMemoryLifecycle } from "../host-integration/lifecycle.js";
import type { ExecutionIdentity } from "../host-integration/types.js";

const TAG = "pi-plugin";

export interface PendingPiCapture {
  readonly generation: number;
  readonly prompt: string;
}

export interface PiRuntimeState {
  memory: MemoryManager | null;
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

export async function createPiRuntime(memoryConfig?: Partial<MemoryConfig>): Promise<PiRuntime> {
  const config = memoryConfig
    ? { ...loadMemoryConfig(), ...memoryConfig }
    : loadMemoryConfig();

  let memory: MemoryManager | null = null;
  let lifecycle: HostMemoryLifecycle | null = null;

  try {
    memory = new MemoryManager(config);
    await memory.initialize({ skipEmbeddingCheck: true });
    lifecycle = new HostMemoryLifecycle(memory, {
      writerId: "abmind-pi-plugin",
      failOpen: true,
    });
    logInfo(TAG, "Memory initialized for Pi plugin");
  } catch (err) {
    logError(TAG, "Memory initialization failed (degraded mode)", err);
    memory = null;
    lifecycle = null;
  }

  const state: PiRuntimeState = {
    memory,
    lifecycle: lifecycle ?? null,
    identity: null,
    pendingWakeUp: "",
    pendingCapture: null,
    captureGeneration: 0,
    lastSettledCaptureGeneration: -1,
    closed: false,
  };

  return {
    state,
    close: () => closeRuntime(state),
  };
}

function closeRuntime(state: PiRuntimeState): void {
  if (state.closed) return;
  state.closed = true;
  state.pendingWakeUp = "";
  state.identity = null;
  resetCaptureState(state);

  if (state.memory) {
    state.memory.close();
    state.memory = null;
  }
  state.lifecycle = null;
  logInfo(TAG, "Pi plugin runtime closed");
}

export function hasDegraded(runtime: PiRuntime): boolean {
  return runtime.state.lifecycle === null;
}

// Capture state machine operations

export function beginCapture(state: PiRuntimeState, prompt: string): void {
  state.captureGeneration++;
  state.pendingCapture = { generation: state.captureGeneration, prompt };
}

export function settleCapture(state: PiRuntimeState): void {
  if (!state.pendingCapture) return;
  state.lastSettledCaptureGeneration = state.pendingCapture.generation;
  state.pendingCapture = null;
}

export function clearPendingCapture(state: PiRuntimeState): void {
  state.pendingCapture = null;
}

export function resetCaptureState(state: PiRuntimeState): void {
  state.captureGeneration = 0;
  state.pendingCapture = null;
  state.lastSettledCaptureGeneration = -1;
}
