import type Database from "better-sqlite3";
import type { ContextEngine as AbmindCtxEngine } from "../context-engine.js";
import type { MemoryManager } from "../memory-manager.js";
import type { MemoryConfig } from "../memory-config.js";

export interface AbmindPluginConfig {
  abmlVersion: string;
  compactionThreshold: number;
  sleepEnabled: boolean;
  stateDir?: string;
  /** Inject top-relevant memories into context before every agent turn. Default false. */
  autoRecall: boolean;
  /** Capture user messages for later memory extraction. Default false. */
  autoCapture: boolean;
  /** Max memories injected per turn when autoRecall is enabled. Default 3, range 1-10. */
  autoRecallMaxResults: number;
  /** Minimum relevance score for a memory to be injected. Default 0.3. */
  autoRecallMinScore: number;
}

export type CompleteFn = (system: string, user: string, maxTokens: number) => Promise<string>;

/**
 * All per-instance state for one abmind plugin registration.
 * Stored in runtime-store.ts under the plugin's id so multiple instances
 * coexist without shared mutable state.
 */
export interface AbmindPluginRuntime {
  readonly pluginId: string;
  readonly contextEngine: AbmindCtxEngine;
  readonly memory: MemoryManager;
  readonly db: Database.Database;
  readonly completeFn: CompleteFn;
  readonly config: AbmindPluginConfig;
  readonly memoryConfig: MemoryConfig;
  readonly ready?: Promise<void>;
}
