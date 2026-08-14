import type { MemoryManager } from "../src/memory-manager.js";
import type { AbmindClient } from "../src/abmind-client.js";
import { SleepDataAccess } from "../src/sleep-data-access.js";
import { requirePrimaryUserId } from "../src/user-utils.js";
import { hookSidecarKey } from "../src/mem-paths.js";
import { HostMemoryLifecycle } from "../src/host-integration/lifecycle.js";
import { resolveHookFormat } from "./hook-output.js";
import type { ExecutionIdentity, HostLifecycleOptions } from "../src/host-integration/types.js";
import type { RecallParams, RecallResult } from "../src/recall-engine.js";
import { extractEnglishTokens } from "../src/query-tokenizer.js";
import type { InstantStoreParams, InstantStoreResult } from "../src/mem-types.js";
import { getMemoryDb } from "../src/memory-manager.js";

export interface HookAdapterContext {
  lifecycle?: HostMemoryLifecycle;
  client?: AbmindClient;
  identity: ExecutionIdentity;
  format: ReturnType<typeof resolveHookFormat>;
  recall(params: { query: string; limit?: number; maxChars?: number }): Promise<{ hits: Array<{ content: string; score: number }>; context: string }>;
}

function formatRecallContext(hits: Array<{ content: string; score: number }>, maxChars: number): string {
  let ctx = "";
  for (const h of hits) {
    const line = `- (score: ${h.score.toFixed(3)}) ${h.content.slice(0, 200)}`;
    if (ctx.length + line.length + 1 > maxChars) break;
    ctx += line + "\n";
  }
  return ctx;
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
      const tokens = extractEnglishTokens(params.query);
      const recallParams: RecallParams = {
        translated: tokens.length > 0 ? tokens : [params.query],
        original: tokens.length === 0 ? params.query : undefined,
        userId: identity.principalId,
        limit: params.limit ?? 5,
        maxClassification: 2,
      };
      const result: RecallResult = await memory.recallSearch(recallParams);
      const hits = result.results.map(h => ({ content: h.content, score: h.score }));
      const context = formatRecallContext(hits, params.maxChars ?? 2000);
      return { hits, context };
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
      const tokens = extractEnglishTokens(params.query);
      const result = await client.privateMemory.recall({
        translated: tokens.length > 0 ? tokens : [params.query],
        original: tokens.length === 0 ? params.query : undefined,
        userId: identity.principalId,
        limit: params.limit ?? 5,
        maxClassification: 2,
      });
      const hits = result.results.map(h => ({ content: h.content, score: h.score }));
      const context = formatRecallContext(hits, params.maxChars ?? 2000);
      return { hits, context };
    },
  };
}
