/**
 * OpenClaw ContextEngine plugin for abmind.
 * Drop-in replacement for lossless-claw.
 *
 * Per-instance isolation: config is constructed from plugin input (no process.env
 * mutation) and the runtime is registered under a pluginId so multiple instances
 * in the same process don't collide. See runtime-store.ts for the pattern.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { ContextEngine } from "../context-engine.js";
import { initializeDatabase } from "../memory-db.js";
import { MemoryManager } from "../memory-manager.js";
import { MEMORY_CONFIG_DEFAULTS, type MemoryConfig } from "../memory-config.js";
import { registerRuntime, removeRuntime, hasRuntime } from "../runtime-store.js";
import { AbmindOpenClawEngine } from "./engine.js";
import { createAbmindRecallTool, createAbmindStoreTool } from "./tools.js";
import { createMemoryPluginRuntime } from "./runtime-adapter.js";
import { buildPromptSection } from "./prompt-builder.js";
import { buildListArtifacts } from "./public-artifacts.js";
import { buildAutoRecallHook, buildAutoCaptureHook } from "./hooks.js";
import type { AbmindPluginConfig, AbmindPluginRuntime } from "./types.js";

/**
 * Construct a plugin-local MemoryConfig from plugin input and defaults.
 * Does NOT read or mutate process.env — all relevant values come from pluginConfig
 * or documented defaults. Multi-instance safe.
 */
function buildPluginMemoryConfig(stateDir: string): MemoryConfig {
  const memoryDir = join(stateDir, "memory");
  return {
    ...MEMORY_CONFIG_DEFAULTS,
    memoryDir,
  };
}

function resolveStateDir(configured: string | undefined): string {
  if (configured) return configured;
  // Fall back to env / home ONLY as a read (never a write). Host controls
  // the env; we respect it for legacy setups but don't mutate it.
  const envHome = process.env.ABMIND_HOME;
  if (envHome) return envHome;
  return join(homedir(), ".abmind");
}

export default {
  id: "abmind",
  name: "abmind Memory + Context Engine",
  description: "Long-term memory, context compaction, sleep cycles, recall",

  configSchema: {
    parse(value: unknown): AbmindPluginConfig {
      const raw = (value && typeof value === "object" && !Array.isArray(value)) ? value as Record<string, unknown> : {};
      return {
        abmlVersion: (raw.abmlVersion as string) ?? "plain",
        compactionThreshold: (raw.compactionThreshold as number) ?? 0.5,
        sleepEnabled: (raw.sleepEnabled as boolean) ?? true,
        stateDir: (raw.stateDir as string) ?? undefined,
        autoRecall: (raw.autoRecall as boolean) ?? false,
        autoCapture: (raw.autoCapture as boolean) ?? false,
        autoRecallMaxResults: Math.min(Math.max((raw.autoRecallMaxResults as number) ?? 3, 1), 10),
        autoRecallMinScore: Math.min(Math.max((raw.autoRecallMinScore as number) ?? 0.3, 0), 1),
      };
    },
  },

  register(api: any) {
    const pluginId = (api.pluginId as string | undefined) ?? "abmind";
    const config = api.config?.plugins?.entries?.abmind?.config ?? {};
    const parsed = this.configSchema.parse(config);

    const stateDir = resolveStateDir(parsed.stateDir);
    const memoryConfig = buildPluginMemoryConfig(stateDir);
    const dbPath = join(memoryConfig.memoryDir, "memory.db");

    const db = initializeDatabase(dbPath);
    const contextEngine = new ContextEngine(db);
    const memory = new MemoryManager(memoryConfig);

    // LLM complete function — dynamic import so pi-ai stays optional.
    const completeFn = async (system: string, user: string, maxTokens: number): Promise<string> => {
      try {
        const piAiModule = "@mariozechner/pi-ai";
        const piAi = await import(piAiModule) as any;
        if (typeof piAi.completeSimple !== "function") return "";
        const result = await piAi.completeSimple({
          messages: [{ role: "user", content: user }],
          system,
          maxTokens,
        });
        const content = result?.content;
        if (Array.isArray(content)) {
          const text = content.find((b: any) => b.type === "text");
          return text?.text ?? "";
        }
        return "";
      } catch { return ""; }
    };

    // Register runtime under pluginId so multi-instance deployments don't
    // collide. If this pluginId is already registered (hot-reload, re-init),
    // dispose the previous registration first.
    if (hasRuntime(pluginId)) {
      removeRuntime(pluginId);
    }
    const runtime: AbmindPluginRuntime = {
      pluginId,
      contextEngine,
      memory,
      db,
      completeFn,
      config: parsed,
      memoryConfig,
    };
    registerRuntime(pluginId, runtime);

    const engine = new AbmindOpenClawEngine(runtime);
    api.registerContextEngine("abmind", () => engine);

    // ── Memory-capability registration (#201) ──────────────────────────────
    if (typeof api.registerMemoryCapability === "function") {
      api.registerMemoryCapability({
        promptBuilder: buildPromptSection,
        flushPlanResolver: () => null, // abmind sleep runs independently; null = no-op
        runtime: createMemoryPluginRuntime(pluginId),
        publicArtifacts: { listArtifacts: buildListArtifacts(pluginId) },
      });
    }

    // ── Agent tools (#347, #359) ──────────────────────────────────────────
    if (typeof api.registerTool === "function") {
      api.registerTool((ctx: { sessionKey?: string }) =>
        createAbmindRecallTool(pluginId, ctx.sessionKey),
      );
      api.registerTool((ctx: { sessionKey?: string }) =>
        createAbmindStoreTool(pluginId, ctx.sessionKey),
      );
    } else {
      // eslint-disable-next-line no-console
      console.warn("[abmind] api.registerTool unavailable — tool registration skipped (ContextEngine still active)");
    }

    // ── Lifecycle hooks (autoRecall + autoCapture) ─────────────────────────
    if (parsed.autoRecall && typeof api.on === "function") {
      api.on("before_agent_start", buildAutoRecallHook({
        pluginId,
        maxResults: parsed.autoRecallMaxResults,
        minScore: parsed.autoRecallMinScore,
      }));
    }
    if (parsed.autoCapture && typeof api.on === "function") {
      api.on("agent_end", buildAutoCaptureHook({ pluginId }));
    }
  },
};
