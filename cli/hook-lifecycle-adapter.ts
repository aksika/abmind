import type { MemoryManager } from "../src/memory-manager.js";
import type { AbmindClient } from "../src/abmind-client.js";
import { SleepDataAccess } from "../src/sleep-data-access.js";
import { requirePrimaryUserId } from "../src/user-utils.js";
import { hookSidecarKey } from "../src/mem-paths.js";
import { HostMemoryLifecycle } from "../src/host-integration/lifecycle.js";
import { resolveHookFormat } from "./hook-output.js";
import type { ExecutionIdentity, HostLifecycleOptions } from "../src/host-integration/types.js";
import { OWNED_RECALL_CONTRACT, OWNED_PROFILE_BOUNDS } from "../src/owned-recall-contract.js";
import type { OwnedRecallPacket } from "../src/owned-recall-contract.js";
import { getMemoryDb } from "../src/memory-manager.js";

export interface HookAdapterContext {
  lifecycle?: HostMemoryLifecycle;
  client?: AbmindClient;
  identity: ExecutionIdentity;
  format: ReturnType<typeof resolveHookFormat>;
  recall(params: { query: string; limit?: number; maxChars?: number }): Promise<HookRecallOutcome>;
}

/** Hook recall outcome: the owner packet plus the text hosts inject.
 * Hosts deliver `context` verbatim; it is already owner-rendered. */
export interface HookRecallOutcome {
  count: number;
  context: string;
  packet: OwnedRecallPacket;
}

/**
 * Host wrapper overhead reserved before requesting capacity: the hook
 * output envelope around the owner text. The owner packet accounts the
 * rest; hooks never clip owner text locally.
 */
const HOOK_WRAPPER_RESERVE_BYTES = 256;

/**
 * #1928 M4 — the common fast core owns planning, search, selection and
 * rendering. The hook supplies the verbatim turn and capacity; no token
 * preparation, compact-selection reconstruction, score floors, or local
 * clipping. The owner text travels intact.
 */
async function recallFastCore(
  recall: (params: { rawTurn: string; maxItems: number; maxOutputBytes: number }) => Promise<OwnedRecallPacket>,
  params: { query: string; limit?: number; maxChars?: number },
): Promise<HookRecallOutcome> {
  const maxChars = params.maxChars ?? 2000;
  const packet = await recall({
    rawTurn: params.query,
    // Host capacity never expands profile work: clamp to the fast ceiling.
    maxItems: Math.max(1, Math.min(params.limit ?? OWNED_PROFILE_BOUNDS.recall_fast.maxItems, OWNED_PROFILE_BOUNDS.recall_fast.maxItems)),
    maxOutputBytes: Math.max(64, Math.min(maxChars - HOOK_WRAPPER_RESERVE_BYTES, OWNED_PROFILE_BOUNDS.recall_fast.maxOutputBytes)),
  });
  return { count: packet.items.length, context: packet.text, packet };
}

export function buildHookAdapterContext(memory: MemoryManager): HookAdapterContext | null {
  const db = getMemoryDb(memory);
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

  return {
    lifecycle,
    identity,
    format,
    async recall(params: { query: string; limit?: number; maxChars?: number }) {
      return recallFastCore(
        ({ rawTurn, maxItems, maxOutputBytes }) =>
          memory.recall({
            contract: OWNED_RECALL_CONTRACT,
            profile: "recall_fast",
            identity: {
              principal: identity.principalId,
              conversation: identity.conversationId,
              execution: identity.executionId,
              host: "abmind-cli-hooks",
            },
            rawTurn,
            capacity: { maxItems, maxOutputBytes },
          }),
        params,
      );
    },
  };
}

export function buildHookClientContext(client: AbmindClient): HookAdapterContext | null {
  const sessionKey = hookSidecarKey();
  const format = resolveHookFormat();

  const identity: ExecutionIdentity = {
    principalId: requirePrimaryUserId(),
    conversationId: sessionKey,
    executionId: sessionKey,
    host: "abmind-cli-hooks",
    origin: "interactive",
    automaticWriteOwner: "abmind-cli-hooks",
  };

  return {
    client,
    identity,
    format,
    async recall(params: { query: string; limit?: number; maxChars?: number }) {
      return recallFastCore(
        ({ rawTurn, maxItems, maxOutputBytes }) =>
          client.privateMemory.recall({
            contract: OWNED_RECALL_CONTRACT,
            profile: "recall_fast",
            identity: {
              principal: identity.principalId,
              conversation: identity.conversationId,
              execution: identity.executionId,
              host: "abmind-cli-hooks",
            },
            rawTurn,
            capacity: { maxItems, maxOutputBytes },
          }),
        params,
      );
    },
  };
}
