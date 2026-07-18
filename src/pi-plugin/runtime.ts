import type { MemoryConfig } from "../memory-config.js";
import { loadMemoryConfig } from "../memory-config.js";
import { AbmindClient } from "../abmind-client.js";
import { LocalTransport } from "../local-transport.js";
import { MemoryManager } from "../memory-manager.js";
import { logError, logInfo, logWarn } from "../mem-logger.js";
import { HostMemoryLifecycle } from "../host-integration/lifecycle.js";
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

  let client: AbmindClient | null = null;
  let memory: MemoryManager | null = null;
  let lifecycle: HostMemoryLifecycle | null = null;

  try {
    const socketPath = join(abmindHome(), "run", "abmind.sock");
    const transport = new LocalTransport(socketPath);

    client = new AbmindClient(transport);
    await client.negotiate();

    logInfo(TAG, "Connected to abmind daemon for Pi plugin");
  } catch (err) {
    logWarn(TAG, `Daemon not available, falling back to embedded mode: ${(err as Error).message}`);

    try {
      memory = new MemoryManager(config);
      await memory.initialize({ skipEmbeddingCheck: true });
      lifecycle = new HostMemoryLifecycle(memory, { writerId: "abmind-pi-plugin", failOpen: true });
      logInfo(TAG, "Memory initialized for Pi plugin (embedded)");
    } catch (memErr) {
      logError(TAG, "Memory initialization failed (degraded mode)", memErr);
      memory = null;
      lifecycle = null;
    }
  }

  const state: PiRuntimeState = {
    client,
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
    close(): void {
      if (state.closed) return;
      state.closed = true;
      client?.close().catch(() => {});
      memory?.close();
    },
  };
}

export function hasDegraded(runtime: PiRuntime): boolean {
  return runtime.state.client === null && runtime.state.memory === null;
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
