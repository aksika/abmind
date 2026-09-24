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
  recall(params: { query: string; limit?: number; maxChars?: number }): Promise<HookRecallOutcome>;
}

/** Compact hook recall outcome: only the rendered context plus its row count.
 *  Never returns a second full copy of every hit's content. */
export interface HookRecallOutcome {
  count: number;
  context: string;
}

/**
 * #1813 — rows to render: the deterministic selection when present and
 * resolvable, otherwise the full result set (ordinary rendering). Rows keep
 * their recall rank order; selection can only bound, never substitute rows.
 * Id-less rows (S6 consolidation files, S8 entity paths) can never be refs,
 * so they ride along after the selected rows in rank order while the same
 * budget covers them — a resolved selection must not silently lose the
 * consolidation/entity evidence that ordinary rendering includes.
 */
function compactSelection(result: RecallResult): Array<{ content: string; score: number }> {
  const full = result.results.map((h) => ({ content: h.content, score: h.score }));
  const selection = result.selection;
  if (selection === undefined || selection.refs.length === 0) return full;
  const byId = new Map<number, { content: string; score: number }>();
  const idless: Array<{ content: string; score: number }> = [];
  for (const h of result.results) {
    const row = { content: h.content, score: h.score };
    if (typeof h.id === "number") byId.set(h.id, row);
    else idless.push(row);
  }
  const selected = selection.refs
    .map((ref) => byId.get(ref.id))
    .filter((h): h is { content: string; score: number } => h !== undefined);
  if (selected.length === 0) return full;
  let used = 0;
  const out: Array<{ content: string; score: number }> = [];
  for (const row of selected) {
    used += Buffer.byteLength(row.content, "utf8");
    out.push(row);
  }
  for (const row of idless) {
    const size = Buffer.byteLength(row.content, "utf8");
    if (used + size > selection.budgetBytes) break;
    out.push(row);
    used += size;
  }
  return out;
}

function formatRecallContext(
  rows: Array<{ content: string; score: number }>,
  maxChars: number,
): HookRecallOutcome {
  let context = "";
  let count = 0;
  for (const h of rows) {
    const line = `- (score: ${h.score.toFixed(3)}) ${h.content.slice(0, 200)}`;
    if (context.length + line.length + 1 > maxChars) break;
    context += line + "\n";
    count++;
  }
  return { count, context };
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
      return formatRecallContext(compactSelection(result), params.maxChars ?? 2000);
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
      return formatRecallContext(compactSelection(result), params.maxChars ?? 2000);
    },
  };
}
