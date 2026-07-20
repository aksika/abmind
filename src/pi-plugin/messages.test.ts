import { describe, it, expect } from "vitest";
import { classifyAssistantEnding } from "./messages.js";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

function asst(
  stopReason: AssistantMessage["stopReason"],
  blocks: AssistantMessage["content"] = [],
): Message {
  return {
    role: "assistant",
    content: blocks,
    stopReason,
    usage: { inputTokens: 0, outputTokens: 0 },
    model: "test",
    api: "anthropic-messages",
    provider: "anthropic",
    timestamp: Date.now(),
  } as AssistantMessage;
}

function user(text = "hello"): Message {
  return { role: "user", content: text, timestamp: 0 } as Message;
}

function textBlock(text: string) {
  return { type: "text" as const, text };
}

function thinkingBlock(text: string) {
  return { type: "thinking" as const, thinking: text };
}

function toolCallBlock(id = "tc-1") {
  return { type: "toolCall" as const, id, name: "test", arguments: {} } as never;
}

describe("classifyAssistantEnding", () => {
  it("success with text", () => {
    const msgs: Message[] = [asst("stop", [textBlock("Hello world")])];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "success", text: "Hello world" });
  });

  it("success with multiple text blocks joined by newline", () => {
    const msgs: Message[] = [
      asst("stop", [textBlock("First"), textBlock("Second")]),
    ];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "success", text: "First\nSecond" });
  });

  it("success with mixed content only extracts text blocks", () => {
    const msgs: Message[] = [
      asst("stop", [textBlock("Answer"), thinkingBlock("thinking..."), toolCallBlock()]),
    ];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "success", text: "Answer" });
  });

  it("empty success when stop reason but no text blocks", () => {
    const msgs: Message[] = [asst("stop", [thinkingBlock("hmm")])];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "empty_success" });
  });

  it("empty success when stop reason with empty text block", () => {
    const msgs: Message[] = [asst("stop", [textBlock("")])];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "empty_success" });
  });

  it("retain error", () => {
    const msgs: Message[] = [asst("error")];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "retain", reason: "error" });
  });

  it("retain toolUse", () => {
    const msgs: Message[] = [asst("toolUse", [toolCallBlock()])];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "retain", reason: "toolUse" });
  });

  it("retain missing when no assistant message", () => {
    const msgs: Message[] = [user("hello")];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "retain", reason: "missing" });
  });

  it("terminal_skip aborted", () => {
    const msgs: Message[] = [asst("aborted")];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "terminal_skip", reason: "aborted" });
  });

  it("terminal_skip length", () => {
    const msgs: Message[] = [asst("length")];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "terminal_skip", reason: "length" });
  });

  it("uses last assistant message when multiple", () => {
    const msgs: Message[] = [
      asst("stop", [textBlock("old")]),
      asst("error"),
    ];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "retain", reason: "error" });
  });

  it("empty messages array returns missing", () => {
    expect(classifyAssistantEnding([])).toEqual({ kind: "retain", reason: "missing" });
  });

  it("ignores user and toolResult messages", () => {
    const msgs: Message[] = [
      user("hello"),
      { role: "toolResult", toolCallId: "tc-1", toolName: "test", content: [textBlock("res")], isError: false, timestamp: 0 } as Message,
    ];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "retain", reason: "missing" });
  });

  it("tool-only content with stop reason still returns toolUse via stopReason", () => {
    const msgs: Message[] = [asst("stop")];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "empty_success" });
  });
});
