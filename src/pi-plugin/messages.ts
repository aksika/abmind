import type { AgentMessage, AssistantMessage, TextContent } from "./pi-types.js";

const COMPOSITION_MAX_CHARS = 16_000;

export function extractAssistantText(messages: AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    const asst = msg as AssistantMessage;
    if (asst.stopReason !== "stop") continue;
    const textParts: string[] = [];
    for (const block of asst.content) {
      if (block.type === "text") {
        textParts.push((block as TextContent).text);
      }
    }
    if (textParts.length > 0) return textParts.join("\n");
  }
  return undefined;
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
