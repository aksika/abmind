/**
 * runtime-adapter.ts — bridges abmind's MemoryManager + recallSearch onto
 * OpenClaw's MemoryPluginRuntime / MemorySearchManager surface.
 *
 * Boundaries: all OpenClaw SDK types are `any` (option b.1). Shape drift is
 * caught by the integration smoke test against a real openclaw dev install,
 * not at compile time.
 *
 * Path convention: abmind is SQLite-backed, so "files" are synthesized from
 * memory rows on demand. Search results return relPaths in the form
 *   "abmind://memory/<id>"
 * and readFile detects the scheme and routes to DB synthesis. No filesystem
 * interop — any plain `fs.readFile` path on a synthetic relPath fails loudly.
 */

import { getRuntime } from "../runtime-store.js";
import { loadEmbedConfig } from "../ollama-embed.js";
import type { AbmindPluginRuntime } from "./types.js";

// ── Synthetic URI helpers ─────────────────────────────────────────────────

const ABMIND_URI_SCHEME = "abmind://";
const ABMIND_MEMORY_PREFIX = `${ABMIND_URI_SCHEME}memory/`;

/** Build the canonical relPath for a memory row. */
export function abmindUri(memoryId: number): string {
  return `${ABMIND_MEMORY_PREFIX}${memoryId}`;
}

/** Parse an abmind:// URI back to the memory id. Returns null if the scheme doesn't match. */
export function parseAbmindUri(uri: string): { memoryId: number } | null {
  if (typeof uri !== "string" || !uri.startsWith(ABMIND_MEMORY_PREFIX)) return null;
  const idStr = uri.slice(ABMIND_MEMORY_PREFIX.length);
  if (!/^\d+$/.test(idStr)) return null;
  const memoryId = Number(idStr);
  if (!Number.isSafeInteger(memoryId) || memoryId <= 0) return null;
  return { memoryId };
}

// ── MemorySearchManager ────────────────────────────────────────────────────

/**
 * Build a MemorySearchManager bound to a specific plugin runtime.
 * Each agent in OpenClaw gets its own manager via
 * MemoryPluginRuntime.getMemorySearchManager — but since our plugin is
 * single-instance-per-process (one abmind DB per plugin registration),
 * every agent shares the SAME manager. That's fine for our deployment
 * model; revisit if OpenClaw ever needs per-agent isolation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMemorySearchManager(pluginId: string): any {
  const runtime = getRuntime<AbmindPluginRuntime>(pluginId);
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async search(query: string, opts?: any): Promise<any[]> {
      const limit = Math.min(Math.max((opts?.limit as number) ?? 10, 1), 50);
      const result = await runtime.memory.recallSearch({
        translated: [query],
        userId: (opts?.userId as string) ?? "default",
        limit,
        maxClassification: (opts?.maxClassification as number) ?? 2,
        topic: opts?.topic as string | undefined,
      });
      return result.results.map((h) => ({
        // OpenClaw MemorySearchResult shape — keep familiar fields, let the
        // host runtime project whatever it needs. Type is `any`.
        relPath: h.id !== undefined ? abmindUri(h.id) : undefined,
        content: h.content,
        score: h.score,
        memoryId: h.id,
        memoryType: h.memoryType,
        topic: h.topic,
        date: h.date,
        source: h.source,
      }));
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async readFile(params: { relPath: string; from?: number; lines?: number }): Promise<any> {
      const parsed = parseAbmindUri(params.relPath);
      if (!parsed) {
        throw new Error(
          `abmind readFile: relPath "${params.relPath}" is not an abmind:// URI. ` +
            `Only search-returned relPaths are readable; filesystem paths are not supported.`,
        );
      }
      const row = runtime.db
        .prepare("SELECT id, content_en, content_original, memory_type, topic, created_at, classification FROM extracted_memories WHERE id = ?")
        .get(parsed.memoryId) as
        | {
            id: number;
            content_en: string | null;
            content_original: string | null;
            memory_type: string | null;
            topic: string | null;
            created_at: number;
            classification: number;
          }
        | undefined;
      // OpenClaw's ordinary synthetic-file surface is model-visible. Legacy
      // class-3 rows may still contain plaintext while migration is ongoing,
      // so fail closed for every class-3 row here; secret_find is the only
      // dedicated path that may return sealed metadata.
      if (!row || row.classification >= 3) {
        throw new Error(`abmind readFile: memory ${parsed.memoryId} not found`);
      }
      const body = row.content_en ?? row.content_original ?? "";
      const dateStr = new Date(row.created_at).toISOString().slice(0, 10);
      const header = `# Memory ${row.id}\n\n- Type: ${row.memory_type ?? "unknown"}\n- Topic: ${row.topic ?? "general"}\n- Date: ${dateStr}\n\n`;
      const full = header + body;
      // Apply line slicing if requested
      if (params.from !== undefined || params.lines !== undefined) {
        const all = full.split("\n");
        const from = Math.max(params.from ?? 0, 0);
        const count = params.lines ?? all.length - from;
        return { text: all.slice(from, from + count).join("\n"), path: params.relPath };
      }
      return { text: full, path: params.relPath };
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    status(): any {
      const embed = loadEmbedConfig();
      return {
        backend: "abmind-sqlite",
        embeddingAvailable: embed.enabled,
        embeddingModel: embed.enabled ? embed.model : null,
        embeddingUrl: embed.enabled ? embed.url : null,
        vectorAvailable: embed.enabled, // vector search = embedding search in abmind
      };
    },

    async probeEmbeddingAvailability(): Promise<boolean> {
      const embed = loadEmbedConfig();
      if (!embed.enabled) return false;
      try {
        const res = await fetch(`${embed.url}/api/tags`, { method: "GET" });
        return res.ok;
      } catch {
        return false;
      }
    },

    async probeVectorAvailability(): Promise<boolean> {
      // In abmind, vector availability == embedding availability (FTS5 alone
      // doesn't count as vector). Delegate to the same probe.
      const embed = loadEmbedConfig();
      if (!embed.enabled) return false;
      try {
        const res = await fetch(`${embed.url}/api/tags`, { method: "GET" });
        return res.ok;
      } catch {
        return false;
      }
    },

    close(): void {
      // abmind lifecycle is owned by the plugin registration, not individual
      // MemorySearchManagers. Close is a no-op here; dispose() on the engine
      // handles DB teardown.
    },
  };
}

// ── MemoryPluginRuntime ────────────────────────────────────────────────────

/**
 * Build a MemoryPluginRuntime for this plugin. Single-instance: every agent
 * shares one MemorySearchManager backed by the plugin's AbmindPluginRuntime.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createMemoryPluginRuntime(pluginId: string): any {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getMemorySearchManager(_params: { cfg?: any; agentId?: string; purpose?: string }): any {
      return { manager: createMemorySearchManager(pluginId) };
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolveMemoryBackendConfig(_params: { cfg?: any; agentId?: string }): any {
      return { backend: "builtin" };
    },

    closeAllMemorySearchManagers(): void {
      // Managers share the plugin's DB, which is closed via dispose(). No-op.
    },
  };
}
