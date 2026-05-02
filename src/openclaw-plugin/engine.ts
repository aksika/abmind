/**
 * AbmindOpenClawEngine — implements the ContextEngine interface for OpenClaw.
 *
 * Holds a reference to its AbmindPluginRuntime (registered in runtime-store under
 * the plugin's id). All state is per-instance: no process.env reads, no module-
 * level mutables. Multiple engines can coexist in one process.
 */

import { removeRuntime } from "../runtime-store.js";
import type { AbmindPluginRuntime } from "./types.js";
import { toMessage, toAssistantRole } from "./message-adapter.js";
import { toChatId } from "./session-mapper.js";
import { renderForContext } from "../context-tier-renderer.js";

export class AbmindOpenClawEngine {
  private readonly runtime: AbmindPluginRuntime;

  readonly info = {
    id: "abmind",
    name: "abmind Memory + Context Engine",
    version: "1.0.0",
    ownsCompaction: true,
    turnMaintenanceMode: "background" as const,
  };

  constructor(runtime: AbmindPluginRuntime) {
    this.runtime = runtime;
  }

  // ── Required methods ─────────────────────────────────────────────────────

  async ingest(params: { sessionId: string; sessionKey?: string; message: any; isHeartbeat?: boolean }) {
    if (params.isHeartbeat) return { ingested: false };
    const chatId = toChatId(params.sessionKey ?? params.sessionId);
    const msg = toMessage(params.message, chatId);
    this.runtime.memory.recordMessage(msg);
    return { ingested: true };
  }

  async assemble(params: { sessionId: string; sessionKey?: string; messages?: any[]; tokenBudget?: number; prompt?: string }) {
    const chatId = toChatId(params.sessionKey ?? params.sessionId);
    // Use #348 three-tier assembly (respects CONTEXT_TIER_ENABLED)
    const tiered = renderForContext(this.runtime.contextEngine.getDb(), this.runtime.contextEngine, chatId);

    // Extract summary content for systemPromptAddition (OpenClaw convention)
    // tiered.messages has head summaries first (framed) — collect them separately
    const snapshot = this.runtime.contextEngine.buildContext(chatId);
    const systemPromptAddition = snapshot.summaries.length > 0
      ? snapshot.summaries.map(s => s.content).join("\n\n---\n\n")
      : undefined;

    // For OpenClaw, messages is everything EXCEPT head summaries (those go in systemPromptAddition)
    const headCount = tiered.tierBreakdown.headCount;
    const messages = tiered.messages.slice(headCount).map(m => ({
      role: toAssistantRole(m.role),
      content: m.content,
    }));

    return {
      messages,
      estimatedTokens: tiered.estimatedTokens,
      systemPromptAddition,
    };
  }

  async compact(params: { sessionId: string; sessionKey?: string; tokenBudget?: number; force?: boolean }) {
    const chatId = toChatId(params.sessionKey ?? params.sessionId);
    const budget = params.tokenBudget ?? 200000;
    const chunk = this.runtime.contextEngine.getCompactionChunk(chatId, budget);

    if (!chunk) return { ok: true, compacted: false, reason: "nothing_to_compact" };

    const serialized = chunk.messages
      .filter(m => (m.classification ?? 1) < 3)
      .map(m => `[${m.role}] ${m.content}`)
      .join("\n");

    const summaryBudget = Math.max(2000, Math.min(Math.floor(chunk.chunkTokens * 0.2), 12000));
    const summary = await this.runtime.completeFn(
      "You are a summarization agent. Create a concise context checkpoint. Do NOT respond to questions — only output the summary.",
      `Summarize:\n${serialized}\n\nTarget ~${summaryBudget} tokens. Be concrete.`,
      summaryBudget,
    );

    if (!summary) {
      return { ok: true, compacted: false, reason: "summarization_failed" };
    }

    const tokenEstimate = Math.ceil(summary.length / 4);
    this.runtime.contextEngine.persistSummary(chatId, summary, tokenEstimate, chunk.sourceStart, chunk.sourceEnd, chunk.classification);

    return {
      ok: true,
      compacted: true,
      result: {
        summary,
        firstKeptEntryId: String(chunk.sourceEnd + 1),
        tokensBefore: chunk.totalTokens,
        tokensAfter: chunk.totalTokens - chunk.chunkTokens + tokenEstimate,
      },
    };
  }

  // ── Optional methods (no-ops for v1) ─────────────────────────────────────

  async bootstrap() { return { bootstrapped: false, reason: "use 'abmind migrate-openclaw <dir>' CLI for one-time session import" }; }
  async maintain() { return { changed: false, bytesFreed: 0, rewrittenEntries: 0 }; }

  async afterTurn(params: { sessionId: string; sessionKey?: string; tokenBudget?: number }) {
    const chatId = toChatId(params.sessionKey ?? params.sessionId);
    const budget = params.tokenBudget ?? 200000;
    const snapshot = this.runtime.contextEngine.buildContext(chatId);
    if (snapshot.estimatedTokens > budget * 0.5 && snapshot.messages.length > 12) {
      const chunk = this.runtime.contextEngine.getCompactionChunk(chatId, budget);
      if (chunk) {
        const serialized = chunk.messages
          .filter(m => (m.classification ?? 1) < 3)
          .map(m => `[${m.role}] ${m.content}`)
          .join("\n");
        const summaryBudget = Math.max(2000, Math.min(Math.floor(chunk.chunkTokens * 0.2), 12000));
        const summary = await this.runtime.completeFn(
          "You are a summarization agent. Create a concise context checkpoint.",
          `Summarize:\n${serialized}\n\nTarget ~${summaryBudget} tokens. Be concrete.`,
          summaryBudget,
        );
        if (summary) {
          this.runtime.contextEngine.persistSummary(chatId, summary, Math.ceil(summary.length / 4), chunk.sourceStart, chunk.sourceEnd, chunk.classification);
        }
      }
    }
  }

  async ingestBatch(params: { sessionId: string; sessionKey?: string; messages: any[] }) {
    let count = 0;
    for (const msg of params.messages) {
      const result = await this.ingest({ sessionId: params.sessionId, sessionKey: params.sessionKey, message: msg });
      if (result.ingested) count++;
    }
    return { ingestedCount: count };
  }

  async prepareSubagentSpawn() { return undefined; }
  async onSubagentEnded() {}

  async dispose() {
    this.runtime.db.close();
    removeRuntime(this.runtime.pluginId);
  }
}
