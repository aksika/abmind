import type { MemoryManager } from "../src/memory-manager.js";
import { SleepDataAccess } from "../src/sleep-data-access.js";
import { hookSidecarKey } from "../src/mem-paths.js";
import { HostMemoryLifecycle } from "../src/host-integration/lifecycle.js";
import { resolveHookFormat } from "./hook-output.js";
import type { ExecutionIdentity, HostLifecycleOptions } from "../src/host-integration/types.js";

export interface HookAdapterContext {
  lifecycle: HostMemoryLifecycle;
  identity: ExecutionIdentity;
  format: ReturnType<typeof resolveHookFormat>;
}

export function buildHookAdapterContext(memory: MemoryManager): HookAdapterContext | null {
  const db = memory.getDatabase();
  if (!db) return null;

  const sleepData = new SleepDataAccess(db);
  let userId: string;
  try { userId = sleepData.getPrimaryUserId(); }
  catch { return null; }

  const sessionKey = hookSidecarKey();
  const format = resolveHookFormat();

  const identity: ExecutionIdentity = {
    principalId: userId,
    conversationId: sessionKey,
    executionId: sessionKey,
    host: "abmind-cli-hooks",
    origin: "interactive",
    automaticWriteOwner: "abmind-cli-hooks",
  };

  const options: HostLifecycleOptions = {
    writerId: "abmind-cli-hooks",
  };

  const lifecycle = new HostMemoryLifecycle(memory, options);

  return { lifecycle, identity, format };
}
