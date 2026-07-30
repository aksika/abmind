/**
 * abmind MCP server — exposes memory as MCP tools over stdio.
 * Usage: abmind mcp
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadMemoryConfig } from "./memory-config.js";
import { getMemoryClient, closeClient, isClient, isManager, type MemoryClient } from "./backend-factory.js";
import { loadMasterUserId } from "./user-utils.js";

export async function startMcpServer(): Promise<void> {
  const config = loadMemoryConfig();
  const mem = await getMemoryClient(true, config);
  const defaultUserId = loadMasterUserId();

  const server = new McpServer({ name: "abmind", version: "0.5.0" });

  server.tool(
    "memory_recall",
    "Search persistent memory using full 4-layer recall (FTS5, trigram, semantic, consolidated)",
    { query: z.string(), userId: z.string().optional() } as any,
    async ({ query, userId }: any) => {
      const uid = userId ?? defaultUserId;
      if (isClient(mem)) {
        const result = await mem.privateMemory.recall({ translated: [query], original: query, userId: uid, limit: 10 });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
      const { recallSearch } = await import("./recall-engine.js");
      const db = mem.getDatabase()!;
      const index = mem.getMemoryIndex()!;
      const result = await recallSearch({ db, index, memoryDir: config.memoryDir }, { translated: [query], original: query, userId: uid, limit: 10 });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "memory_store",
    "Store a new memory — facts, preferences, decisions, or events",
    { text: z.string(), memoryType: z.enum(["fact", "preference", "decision", "event"]), userId: z.string().optional() } as any,
    async ({ text, memoryType, userId }: any) => {
      const uid = userId ?? defaultUserId;
      if (isClient(mem)) {
        const result = await mem.privateMemory.instantStore({ userId: uid, contentEn: text, contentOriginal: text, memoryType, emotionScore: 0 });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }
      const result = mem.editor.instantStore({ userId: uid, contentEn: text, contentOriginal: text, memoryType, emotionScore: 0 });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "memory_edit",
    "Boost or demote a memory's importance (v1: boost/demote only)",
    { memoryId: z.number(), expectedRevision: z.number().int().positive(), action: z.enum(["boost", "demote"]) } as any,
    async ({ memoryId, expectedRevision, action }: any) => {
      const delta = action === "boost" ? 10 : -10;
      const uid = defaultUserId;
      if (isClient(mem)) {
        await mem.privateMemory.adjustRelevance({ userId: uid, memoryId, expectedRevision, delta });
      } else {
        const result = mem.editor.getMutationStore().adjustRelevance(
          { userId: uid, actorId: "mcp", operationKey: `mcp-${Date.now()}`, canDeclassifySecret: false, origin: "adapter" },
          { userId: uid, memoryId, expectedRevision, delta },
        );
        if (!result.ok) throw new Error(result.code === "validation_error" ? result.message : result.code);
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, memoryId, action }) }] };
    },
  );

  server.tool(
    "memory_status",
    "Get memory system statistics",
    { userId: z.string().optional() } as any,
    async ({ _userId }: any) => {
      if (isManager(mem)) {
        const stats = mem.getStats();
        return { content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }] };
      }
      const status = await mem.system.status();
      return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }] };
    },
  );

  server.tool(
    "memory_wakeup",
    "Get wake-up context for session start — recent memories, core knowledge, emotional state",
    { maxChars: z.number().optional() } as any,
    async ({ maxChars }: any) => {
      if (isManager(mem)) {
        const wakeup = mem.buildWakeUp(maxChars);
        return { content: [{ type: "text" as const, text: wakeup }] };
      }
      return { content: [{ type: "text" as const, text: "Wake-up context not available in daemon mode (use embedded)." }] };
    },
  );

  server.tool(
    "memory_bundle",
    "Get session bundle — SOUL identity, user profile, agent notes, memory tool instructions",
    {} as any,
    async () => {
      if (isManager(mem)) {
        const b = mem.getSessionBundle();
        const parts = [b.soul, b.memoryTools, b.profile, b.notes].filter(Boolean);
        return { content: [{ type: "text" as const, text: parts.join("\n\n---\n\n") }] };
      }
      return { content: [{ type: "text" as const, text: "Session bundle not available in daemon mode (use embedded)." }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
