import type { MemoryConfig } from "../memory-config.js";
import { loadMemoryConfig } from "../memory-config.js";
import { MemoryManager } from "../memory-manager.js";
import { logError, logInfo, logWarn } from "../mem-logger.js";
import { HostMemoryLifecycle } from "../host-integration/lifecycle.js";
import type { ExecutionIdentity } from "../host-integration/types.js";

const TAG = "pi-plugin";

export interface PiRuntimeState {
  memory: MemoryManager | null;
  lifecycle: HostMemoryLifecycle | null;
  identity: ExecutionIdentity | null;
  pendingWakeUp: string;
  pendingUserPrompt: string | null;
  runGeneration: number;
  lastCapturedGeneration: number;
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
    await memory.initialize();
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
    pendingUserPrompt: null,
    runGeneration: 0,
    lastCapturedGeneration: -1,
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
  state.pendingUserPrompt = null;
  state.identity = null;
  state.runGeneration = 0;
  state.lastCapturedGeneration = -1;

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
