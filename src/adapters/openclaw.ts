/**
 * abmind OpenClaw plugin — registers memory capability via registerMemoryCapability (Path A).
 *
 * Usage: In OpenClaw plugin config, point to this module.
 * Requires abmind to be installed and ABMIND_HOME set (or defaults to ~/.abmind).
 */

import { loadMemoryConfig } from "../memory-config.js";
import { MemoryManager } from "../memory-manager.js";
import { createMemoryBackend } from "../backend-factory.js";
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
  const memory = new MemoryManager(config);
  await memory.initialize();

  let backend: Awaited<ReturnType<typeof createMemoryBackend>> | null = null;
  try { backend = await createMemoryBackend(config); } catch (err) {
    api.logger.error(`[abmind] Failed to create backend: ${err}`);
  }

  const masterUserId = loadMasterUserId();
  const dataDir = abmindHome();

  const promptBuilder = (): string[] => {
    try {
      const wakeup = memory.buildWakeUp();
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
      if (!backend) return [];
      try {
        const result = await backend.recall({ translated: [query], userId: masterUserId, limit: opts?.maxResults ?? 10 });
        return result.results.map(r => ({
          content: r.content,
          path: `memory://${r.source}`,
          score: r.score ?? 0.5,
          snippet: r.content.slice(0, 200),
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
      const stats = memory.getStats();
      return { enabled: true, ready: !!stats, error: stats ? undefined : "Memory not initialized" };
    },
    async close() { memory.close(); },
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
        memory.close();
      },
    },
  });

  api.logger.info(`[abmind] Memory plugin registered (user: ${masterUserId}, data: ${dataDir})`);
}
