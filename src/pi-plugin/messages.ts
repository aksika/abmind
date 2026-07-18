import type { AgentMessage, AssistantMessage } from "./pi-types.js";

const COMPOSITION_MAX_CHARS = 16_000;

export type PiAssistantEnding =
  | { kind: "success"; text: string }
  | { kind: "empty_success" }
  | { kind: "retain"; reason: "error" | "toolUse" | "missing" }
  | { kind: "terminal_skip"; reason: "aborted" | "length" };

function findLastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === "assistant") return msg as AssistantMessage;
  }
  return undefined;
}

export function classifyAssistantEnding(messages: readonly AgentMessage[]): PiAssistantEnding {
  const last = findLastAssistant(messages);
  if (!last) return { kind: "retain", reason: "missing" };

  const { stopReason, content } = last;

  switch (stopReason) {
    case "stop": {
      const textParts: string[] = [];
      for (const block of content) {
        if (block.type === "text") {
          textParts.push(block.text);
        }
      }
      const text = textParts.join("\n");
      if (!text) return { kind: "empty_success" };
      return { kind: "success", text };
    }
    case "error":
      return { kind: "retain", reason: "error" };
    case "toolUse":
      return { kind: "retain", reason: "toolUse" };
    case "aborted":
      return { kind: "terminal_skip", reason: "aborted" };
    case "length":
      return { kind: "terminal_skip", reason: "length" };
  }
}

export function composeAbmindContext(wakeUp: string, recall: string): string | undefined {
  const sections: string[] = [];

  if (wakeUp.trim()) {
    sections.push(`[Wake-up context]\n${wakeUp.trim()}`);
  }

  if (recall.trim()) {
    sections.push(`[Memory recall]\n${recall.trim()}`);
  }

  if (sections.length === 0) return undefined;

  const joined = sections.join("\n\n");
  if (joined.length <= COMPOSITION_MAX_CHARS) return joined;

  return joined.slice(0, COMPOSITION_MAX_CHARS);
}
