/**
 * abmind MCP server — exposes memory as MCP tools over stdio.
 * Usage: abmind mcp
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadMemoryConfig } from "./memory-config.js";
import { MemoryManager } from "./memory-manager.js";
import { createMemoryBackend } from "./backend-factory.js";
import { loadMasterUserId } from "./user-utils.js";

export async function startMcpServer(): Promise<void> {
  const config = loadMemoryConfig();
  const memory = new MemoryManager(config);
  await memory.initialize();
  const backend = await createMemoryBackend(config);
  const defaultUserId = loadMasterUserId();

  const server = new McpServer({ name: "abmind", version: "0.5.0" });

  server.tool(
    "memory_recall",
    "Search persistent memory using full 4-layer recall (FTS5, trigram, semantic, consolidated)",
    { query: z.string(), userId: z.string().optional() },
    async ({ query, userId }) => {
      const uid = userId ?? defaultUserId;
      const result = await backend.recall({ translated: [query], original: query, userId: uid, limit: 10 });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "memory_store",
    "Store a new memory — facts, preferences, decisions, or events",
    { text: z.string(), memoryType: z.enum(["fact", "preference", "decision", "event"]), userId: z.string().optional() },
    async ({ text, memoryType, userId }) => {
      const uid = userId ?? defaultUserId;
      const result = await backend.instantStore({ userId: uid, contentEn: text, contentOriginal: text, memoryType, emotionScore: 0 });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "memory_edit",
    "Boost or demote a memory's importance (v1: boost/demote only)",
    { memoryId: z.number(), action: z.enum(["boost", "demote"]) },
    async ({ memoryId, action }) => {
      const delta = action === "boost" ? 10 : -10;
      await backend.adjustRelevance(memoryId, delta);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, memoryId, action }) }] };
    },
  );

  server.tool(
    "memory_status",
    "Get memory system statistics",
    { userId: z.string().optional() },
    async ({ userId }) => {
      const stats = memory.getStats();
      return { content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }] };
    },
  );

  server.tool(
    "memory_wakeup",
    "Get wake-up context for session start — recent memories, core knowledge, emotional state",
    { maxChars: z.number().optional() },
    async ({ maxChars }) => {
      const wakeup = memory.buildWakeUp(maxChars);
      return { content: [{ type: "text" as const, text: wakeup }] };
    },
  );

  server.tool(
    "memory_bundle",
    "Get session bundle — SOUL identity, user profile, agent notes, memory tool instructions",
    {},
    async () => {
      const b = memory.getSessionBundle();
      const parts = [b.soul, b.memoryTools, b.profile, b.notes].filter(Boolean);
      return { content: [{ type: "text" as const, text: parts.join("\n\n---\n\n") }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
