/**
 * hooks.ts — lifecycle hook builders for autoRecall + autoCapture.
 *
 * Both hooks are opt-in via plugin config (default false). When enabled, they
 * are wired to OpenClaw's hook API in the plugin's register() function.
 *
 * - autoRecall: on "before_agent_start", search memories matching the user
 *   prompt and inject top-N results into the agent's context. Closes the
 *   gap where memory-lancedb's auto-recall beats abmind on default behavior.
 *
 * - autoCapture: on "agent_end", record the user message for later memory
 *   extraction by the sleep pipeline. User messages ONLY (not assistant
 *   output) — matches lossless-claw's self-poisoning mitigation.
 *
 * OpenClaw event payload types are `any` (option b.1). Handler contract is
 * validated by OpenClaw at registration, not compile time.
 */

import { getRuntime } from "../runtime-store.js";
import type { AbmindPluginRuntime } from "./types.js";

interface AutoRecallDeps {
  pluginId: string;
  maxResults: number;
  minScore: number;
}

/**
 * Build a `before_agent_start` handler that injects top-relevant memories
 * into the agent's context for each user prompt.
 *
 * Handler reads the user prompt from the event, runs abmind recall, and
 * returns additional context lines to inject. Empty result = no injection.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildAutoRecallHook(deps: AutoRecallDeps): (event: any) => Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async function autoRecallHandler(event: any): Promise<any> {
    const runtime = getRuntime<AbmindPluginRuntime>(deps.pluginId);
    const prompt = extractPromptFromEvent(event);
    if (!prompt) return {}; // No prompt to key off — silent no-op

    try {
      const result = await runtime.memory.recallSearch({
        translated: [prompt],
        userId: extractUserId(event) ?? "default",
        limit: deps.maxResults,
        maxClassification: 2,
      });
      const hits = result.results.filter((h) => (h.score ?? 0) >= deps.minScore);
      if (hits.length === 0) return {};

      const lines = [
        `[Relevant memory — abmind auto-recall, ${hits.length} hit${hits.length > 1 ? "s" : ""}]`,
        ...hits.map((h, i) => {
          const idx = i + 1;
          const date = h.date ? ` (${h.date})` : "";
          const type = h.memoryType ? `[${h.memoryType}] ` : "";
          return `${idx}. ${type}${h.content}${date}`;
        }),
      ];
      // OpenClaw's hook result shape varies; we return { context: string[] }
      // as a conservative pattern. Runtime validates.
      return { context: lines };
    } catch {
      // Recall failure is non-fatal — don't break the turn. Hook must return
      // an empty/neutral value, never throw.
      return {};
    }
  };
}

interface AutoCaptureDeps {
  pluginId: string;
}

/**
 * Build an `agent_end` handler that records user messages from the completed
 * turn into abmind's messages table. Assistant output is NOT captured
 * (self-poisoning mitigation).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildAutoCaptureHook(deps: AutoCaptureDeps): (event: any) => Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async function autoCaptureHandler(event: any): Promise<void> {
    const runtime = getRuntime<AbmindPluginRuntime>(deps.pluginId);
    const userMessages = extractUserMessages(event);
    if (userMessages.length === 0) return;

    const userId = extractUserId(event) ?? "default";
    const sessionId = extractSessionId(event) ?? "default";
    const baseTimestamp = Date.now();

    try {
      for (let i = 0; i < userMessages.length; i++) {
        runtime.memory.recordMessage({
          role: "user",
          content: userMessages[i]!,
          timestamp: baseTimestamp + i, // preserve ordering within the turn
          userId,
          sessionId,
        });
      }
    } catch {
      // Capture failure is non-fatal — don't break the turn.
    }
  };
}

// ── Event shape extraction ────────────────────────────────────────────────
// OpenClaw event payloads are not typed at our boundary. These helpers try
// common shapes (user prompt, messages array) and fall back gracefully.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractPromptFromEvent(event: any): string | null {
  if (!event || typeof event !== "object") return null;
  // Most common: event.prompt or event.userPrompt
  if (typeof event.prompt === "string") return event.prompt;
  if (typeof event.userPrompt === "string") return event.userPrompt;
  // Alternative: event.messages is an array, last user message wins
  if (Array.isArray(event.messages)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const m = event.messages[i];
      if (m?.role === "user" && typeof m.content === "string") return m.content;
    }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractUserMessages(event: any): string[] {
  if (!event || typeof event !== "object") return [];
  if (!Array.isArray(event.messages)) return [];
  const results: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const m of event.messages) {
    if (m?.role === "user" && typeof m.content === "string") results.push(m.content);
  }
  return results;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractUserId(event: any): string | null {
  if (!event || typeof event !== "object") return null;
  if (typeof event.userId === "string") return event.userId;
  if (typeof event.agentId === "string") return event.agentId;
  if (typeof event.sessionKey === "string") return event.sessionKey;
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractSessionId(event: any): string | null {
  if (!event || typeof event !== "object") return null;
  if (typeof event.sessionId === "string") return event.sessionId;
  if (typeof event.sessionKey === "string") return event.sessionKey;
  return null;
}
