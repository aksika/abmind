/**
 * message-adapter.ts — Translate between OpenClaw AgentMessage and abmind MessageRecord.
 */

import type { MessageRecord } from "../mem-types.js";

/**
 * Convert an OpenClaw AgentMessage to abmind MessageRecord.
 */
export function toMessage(agentMessage: any, chatId: string): MessageRecord {
  const role = agentMessage.role === "toolResult" ? "tool" : (agentMessage.role ?? "user");
  let content: string;

  if (typeof agentMessage.content === "string") {
    content = agentMessage.content;
  } else if (Array.isArray(agentMessage.content)) {
    // Extract text from content blocks
    content = agentMessage.content
      .map((block: any) => {
        if (typeof block === "string") return block;
        if (block?.type === "text") return block.text ?? "";
        if (block?.type === "toolCall") return `[tool_call: ${block.name ?? "?"}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  } else {
    content = String(agentMessage.content ?? "");
  }

  return {
    role,
    content,
    userId: "openclaw",
    sessionId: chatId,
    timestamp: Date.now(),
  };
}

/**
 * Map abmind role to OpenClaw AgentMessage role.
 */
export function toAssistantRole(role: string): "user" | "assistant" | "toolResult" {
  if (role === "tool") return "toolResult";
  if (role === "assistant") return "assistant";
  return "user";
}
