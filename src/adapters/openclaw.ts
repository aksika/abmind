/**
 * abmind OpenClaw plugin — registers memory capability via registerMemoryCapability (Path A).
 *
 * Usage: In OpenClaw plugin config, point to this module.
 * Requires abmind to be installed and ABMIND_HOME set (or defaults to ~/.abmind).
 */

import { loadMemoryConfig } from "../memory-config.js";
import { getMemoryClient, closeClient, isClient, isManager } from "../backend-factory.js";
import { getMemoryDb } from "../memory-manager.js";
import { loadMasterUserId } from "../user-utils.js";
import { abmindHome } from "../mem-paths.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Types from OpenClaw — kept minimal to avoid hard dependency
interface OcPluginApi {
  logger: { info(msg: string): void; error(msg: string): void };
  registerMemoryCapability(cap: {
    promptBuilder: () => string[];
    flushPlanResolver: () => {
      softThresholdTokens: number;
      forceFlushTranscriptBytes: number;
      reserveTokensFloor: number;
      prompt: string;
      systemPrompt: string;
      relativePath: string;
    } | null;
    runtime: {
      getMemorySearchManager(params: { cfg: unknown; agentId: string }): Promise<{
        manager: OcSearchManager | null;
        error?: string;
      }>;
      resolveMemoryBackendConfig(params: { cfg: unknown; agentId: string }): { backend: "external" };
      closeAllMemorySearchManagers?(): Promise<void>;
    };
  }): void;
}

interface OcSearchManager {
  search(query: string, opts?: { maxResults?: number }): Promise<Array<{ content: string; path: string; score: number; snippet: string }>>;
  readFile(params: { relPath: string; from?: number; lines?: number }): Promise<{ text: string; path: string }>;
  status(): { enabled: boolean; ready: boolean; error?: string };
  close?(): Promise<void>;
}

export async function register(api: OcPluginApi): Promise<void> {
  const config = loadMemoryConfig();
  const mem = await getMemoryClient(false, config);
  const isMgr = isManager(mem);

  const masterUserId = loadMasterUserId();
  const dataDir = abmindHome();

  const promptBuilder = (): string[] => {
    try {
      const wakeup = isMgr ? mem.buildWakeUp() : "Memory context unavailable (daemon mode).";
      return wakeup ? [wakeup] : [];
    } catch (err) {
      api.logger.error(`[abmind] promptBuilder failed: ${err}`);
      return [];
    }
  };

  const flushPlanResolver = () => ({
    softThresholdTokens: 80000,
    forceFlushTranscriptBytes: 200000,
    reserveTokensFloor: 20000,
    prompt: "Summarize the conversation so far.",
    systemPrompt: "You are a conversation summarizer.",
    relativePath: "memory/compaction",
  });

  const buildSearchManager = (): OcSearchManager => ({
    async search(query, opts) {
      try {
        let results: Array<{ content: string; source: string; score?: number }>;
        if (isClient(mem)) {
          const r = await mem.privateMemory.recall({ translated: [query], userId: masterUserId, limit: opts?.maxResults ?? 10 });
          results = r.results.map(h => ({ content: h.content, source: h.source, score: h.score }));
        } else {
          const { recallSearch } = await import("../recall-engine.js");
          const db = getMemoryDb(mem)!;
          const index = mem.getMemoryIndex()!;
          const r = await recallSearch({ db, index, memoryDir: config.memoryDir }, { translated: [query], userId: masterUserId, limit: opts?.maxResults ?? 10 });
          results = r.results.map(rr => ({ content: rr.content, source: rr.source, score: rr.score }));
        }
        return results.map(r => ({
          content: r.content, path: `memory://${r.source}`, score: r.score ?? 0.5, snippet: r.content.slice(0, 200),
        }));
      } catch (err) {
        api.logger.error(`[abmind] search failed: ${err}`);
        return [];
      }
    },
    async readFile({ relPath }) {
      const fullPath = join(dataDir, relPath);
      if (!existsSync(fullPath)) return { text: "", path: fullPath };
      try { return { text: readFileSync(fullPath, "utf-8"), path: fullPath }; }
      catch { return { text: "", path: fullPath }; }
    },
    status() {
      const stats = isMgr ? mem.getStats() : null;
      return { enabled: true, ready: !!stats, error: stats ? undefined : "Memory not available in daemon mode" };
    },
    async close() { closeClient(mem); },
  });

  api.registerMemoryCapability({
    promptBuilder,
    flushPlanResolver,
    runtime: {
      async getMemorySearchManager() {
        return { manager: buildSearchManager() };
      },
      resolveMemoryBackendConfig() {
        return { backend: "external" as const };
      },
      async closeAllMemorySearchManagers() {
        closeClient(mem);
      },
    },
  });

  api.logger.info(`[abmind] Memory plugin registered (user: ${masterUserId}, data: ${dataDir})`);
}
