/**
 * context-orchestrator.ts — Context orchestration — compaction, pruning, condensation.
 * Coordinates: abmind ContextEngine (data) + tool pruning (in-memory) + LLM summarization.
 * Single entry point: getContext(chatId, tokenBudget) → ready-to-send messages.
 */

import type { ContextEngine, ContextMessage } from "./context-engine.js";
import { COMPACTION_THRESHOLD_PCT, TAIL_MIN_MESSAGES, CHARS_PER_TOKEN } from "./context-engine.js";
import { renderForContext } from "./context-tier-renderer.js";
import { pruneToolResults } from "./tool-result-pruner.js";

const TAG = "context";
const PRUNING_THRESHOLD_PCT = 0.35;
const GAP_AGGRESSIVE_MS = 60 * 60 * 1000; // 1 hour

type LogFn = (tag: string, msg: string) => void;
const noop: LogFn = () => {};

export type SummarizeFn = (serializedTurns: string, budget: number, priorSummaries: string) => Promise<string>;

export interface ContextOrchestratorConfig {
  contextEngine: ContextEngine;
  summarize: SummarizeFn;
  getLastAssistantTimestamp: (chatId: string) => number | null;
  log?: { debug?: LogFn; info?: LogFn; warn?: LogFn; error?: LogFn };
}

export interface ContextResult {
  messages: Array<{ role: string; content: string }>;
  compacted: boolean;
  pruned: number;
  estimatedTokens: number;
}

export class ContextOrchestrator {
  private engine: ContextEngine;
  private summarize: SummarizeFn;
  private getLastAssistantTs: (chatId: string) => number | null;
  private logDebug: LogFn;
  private logInfo: LogFn;
  private logWarn: LogFn;
  private logError: LogFn;

  constructor(config: ContextOrchestratorConfig) {
    this.engine = config.contextEngine;
    this.summarize = config.summarize;
    this.getLastAssistantTs = config.getLastAssistantTimestamp;
    this.logDebug = config.log?.debug ?? noop;
    this.logInfo = config.log?.info ?? noop;
    this.logWarn = config.log?.warn ?? noop;
    this.logError = config.log?.error ?? noop;
  }

  /** Main entry point: get context ready to send to LLM API. */
  async getContext(chatId: string, tokenBudget: number): Promise<ContextResult> {
    // Use #348 three-tier assembly (respects CONTEXT_TIER_ENABLED)
    const tiered = renderForContext(this.engine.getDb(), this.engine, chatId);

    // tiered.messages already has head summaries + middle ABM-L + tail verbatim
    const contextMessages = tiered.messages.slice();

    // Tool pruning still applies (in-memory, doesn't modify DB)
    const gap = this.getTimeSinceLastAssistant(chatId);
    const aggressive = gap > GAP_AGGRESSIVE_MS;
    const estimatedTokens = tiered.estimatedTokens;
    let pruned = 0;

    const totalMessageCount = tiered.tierBreakdown.tailCount + tiered.tierBreakdown.middleCount;
    if (aggressive || estimatedTokens > tokenBudget * PRUNING_THRESHOLD_PCT) {
      const tailCount = Math.max(TAIL_MIN_MESSAGES, Math.min(totalMessageCount, Math.ceil(totalMessageCount * 0.3)));
      const pruneResult = pruneToolResults(contextMessages as any, tailCount, aggressive);
      pruned = pruneResult.prunedCount;
      if (pruned > 0) {
        contextMessages.splice(0, contextMessages.length, ...pruneResult.messages as any);
        this.logDebug(TAG, `Pruned ${pruned} tool results (aggressive=${aggressive})`);
      }
    }

    const finalTokens = contextMessages.reduce((s, m) => s + Math.ceil(m.content.length / CHARS_PER_TOKEN), 0);
    this.logDebug(TAG, `context assembled: head=${tiered.tierBreakdown.headCount} middle=${tiered.tierBreakdown.middleCount} tail=${tiered.tierBreakdown.tailCount} pruned=${pruned} est=${finalTokens}tok`);
    return { messages: contextMessages, compacted: false, pruned, estimatedTokens: finalTokens };
  }

  /** Call AFTER response is delivered to user. Fires compaction async if needed. */
  async afterResponse(chatId: string, tokenBudget: number, promptTokens?: number): Promise<void> {
    // Check if compaction needed (from actual API token count or pending flag)
    const snapshot = this.engine.buildContext(chatId);
    const shouldCompact = snapshot.pendingCompaction ||
      (promptTokens != null && promptTokens > tokenBudget * COMPACTION_THRESHOLD_PCT) ||
      snapshot.estimatedTokens > tokenBudget * COMPACTION_THRESHOLD_PCT;

    if (shouldCompact && snapshot.messages.length > TAIL_MIN_MESSAGES) {
      // Fire async — don't block the user
      this.runCompaction(chatId, tokenBudget).catch(err => {
        this.logWarn(TAG, `Background compaction failed for ${chatId}: ${err}`);
      });
    }

    // Check condensation
    const cond = this.engine.needsCondensation(chatId);
    if (cond.needed) {
      this.runCondensation(chatId, cond.leafIds).catch(err => {
        this.logWarn(TAG, `Background condensation failed for ${chatId}: ${err}`);
      });
    }
  }

  /** Handle post-response feedback: trigger async compaction if over threshold. */
  onApiResponse(chatId: string, promptTokens: number, tokenBudget: number): void {
    // Fire-and-forget — user already has their response
    this.afterResponse(chatId, tokenBudget, promptTokens).catch(() => {});
  }

  /** Force compaction (manual /compact or reactive overflow). */
  async forceCompact(chatId: string, tokenBudget: number): Promise<boolean> {
    return this.runCompaction(chatId, tokenBudget);
  }

  /** Archive context on /reset. */
  reset(chatId: string): void {
    this.engine.archiveContext(chatId);
    this.logInfo(TAG, `Context archived for ${chatId}`);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async runCompaction(chatId: string, tokenBudget: number): Promise<boolean> {
    const chunk = this.engine.getCompactionChunk(chatId, tokenBudget);
    if (!chunk) return false;

    try {
      // Serialize chunk for summarizer
      const serialized = this.serializeChunk(chunk.messages);
      const budget = Math.max(2000, Math.min(Math.floor(chunk.chunkTokens * 0.20), Math.floor(tokenBudget * 0.05), 12000));

      // Get prior summaries for continuity
      const summaries = this.engine.getSummaries(chatId);
      const priorContent = summaries.slice(-2).map(s => s.content).join("\n\n");

      // LLM call (one call, never more)
      const summary = await this.summarize(serialized, budget, priorContent);

      if (!summary || summary.trim().length === 0) {
        // Deterministic fallback: truncate to 512 tokens
        const fallback = serialized.slice(0, 512 * CHARS_PER_TOKEN) + "\n[Truncated from " + chunk.chunkTokens + " tokens]";
        const tokenEst = Math.ceil(fallback.length / CHARS_PER_TOKEN);
        this.engine.persistSummary(chatId, fallback, tokenEst, chunk.sourceStart, chunk.sourceEnd, chunk.classification);
        this.logWarn(TAG, `Compaction used deterministic fallback for ${chatId}`);
        return true;
      }

      const tokenEst = Math.ceil(summary.length / CHARS_PER_TOKEN);
      // Anti-inflation: if summary >= input, use fallback
      if (tokenEst >= chunk.chunkTokens) {
        const fallback = serialized.slice(0, 512 * CHARS_PER_TOKEN) + "\n[Truncated from " + chunk.chunkTokens + " tokens]";
        const fbTokens = Math.ceil(fallback.length / CHARS_PER_TOKEN);
        this.engine.persistSummary(chatId, fallback, fbTokens, chunk.sourceStart, chunk.sourceEnd, chunk.classification);
        this.logWarn(TAG, `Compaction inflated (${tokenEst} >= ${chunk.chunkTokens}), used fallback`);
        return true;
      }

      this.engine.persistSummary(chatId, summary, tokenEst, chunk.sourceStart, chunk.sourceEnd, chunk.classification);
      this.logInfo(TAG, `Compacted ${chunk.chunkTokens} tokens → ${tokenEst} tokens for ${chatId}`);
      return true;
    } catch (err) {
      this.engine.setLastFailed(chatId);
      this.logError(TAG, `Compaction failed for ${chatId}: ${err}`);
      return false;
    }
  }

  private async runCondensation(chatId: string, leafIds: number[]): Promise<void> {
    const leaves = this.engine.getSummaries(chatId).filter(s => leafIds.includes(s.id));
    if (leaves.length < 2) return;

    const combined = leaves.map(l => l.content).join("\n\n---\n\n");
    const budget = Math.max(2000, Math.floor(combined.length / CHARS_PER_TOKEN * 0.3));

    try {
      const condensed = await this.summarize(combined, budget, "");
      if (condensed && condensed.trim().length > 0) {
        const tokenEst = Math.ceil(condensed.length / CHARS_PER_TOKEN);
        this.engine.persistCondensedSummary(chatId, condensed, tokenEst, leafIds);
        this.logInfo(TAG, `Condensed ${leaves.length} leaves → ${tokenEst} tokens for ${chatId}`);
      }
    } catch (err) {
      this.logWarn(TAG, `Condensation failed for ${chatId}: ${err}`);
    }
  }

  private serializeChunk(messages: ContextMessage[]): string {
    return messages
      .filter(m => (m.classification ?? 1) < 3) // Exclude SECRET
      .map(m => {
        const ts = this.formatTimestamp(m.timestamp);
        const role = m.role === "assistant" ? "ast" : m.role;
        if (m.role === "tool") return `[${ts}] [${m.content.slice(0, 80)}]`;
        return `[${ts}] ${role}: ${m.content}`;
      })
      .join("\n");
  }

  private formatTimestamp(epochMs: number): string {
    const d = new Date(epochMs);
    const yy = String(d.getUTCFullYear()).slice(2);
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const min = String(d.getUTCMinutes()).padStart(2, "0");
    return `${yy}${mm}${dd}:${hh}${min}`;
  }

  private getTimeSinceLastAssistant(chatId: string): number {
    const ts = this.getLastAssistantTs(chatId);
    if (!ts) return 0;
    return Date.now() - ts;
  }
}
