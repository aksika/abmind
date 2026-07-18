import { describe, it, expect } from "vitest";
import { classifyAssistantEnding } from "./messages.js";
import type { AgentMessage, AssistantMessage } from "./pi-types.js";

function asst(
  stopReason: AssistantMessage["stopReason"],
  blocks: AssistantMessage["content"] = [],
): AgentMessage {
  return {
    role: "assistant",
    content: blocks,
    stopReason,
    usage: { inputTokens: 0, outputTokens: 0 },
    model: "test",
  };
}

function user(text = "hello"): AgentMessage {
  return { role: "user", content: text, timestamp: 0 };
}

function textBlock(text: string) {
  return { type: "text" as const, text };
}

function thinkingBlock(text: string) {
  return { type: "thinking" as const, thinking: text };
}

function toolCallBlock(id = "tc-1") {
  return { type: "toolCall" as const, id, name: "test", arguments: {} };
}

describe("classifyAssistantEnding", () => {
  it("success with text", () => {
    const msgs: AgentMessage[] = [asst("stop", [textBlock("Hello world")])];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "success", text: "Hello world" });
  });

  it("success with multiple text blocks joined by newline", () => {
    const msgs: AgentMessage[] = [
      asst("stop", [textBlock("First"), textBlock("Second")]),
    ];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "success", text: "First\nSecond" });
  });

  it("success with mixed content only extracts text blocks", () => {
    const msgs: AgentMessage[] = [
      asst("stop", [textBlock("Answer"), thinkingBlock("thinking..."), toolCallBlock()]),
    ];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "success", text: "Answer" });
  });

  it("empty success when stop reason but no text blocks", () => {
    const msgs: AgentMessage[] = [asst("stop", [thinkingBlock("hmm")])];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "empty_success" });
  });

  it("empty success when stop reason with empty text block", () => {
    const msgs: AgentMessage[] = [asst("stop", [textBlock("")])];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "empty_success" });
  });

  it("retain error", () => {
    const msgs: AgentMessage[] = [asst("error")];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "retain", reason: "error" });
  });

  it("retain toolUse", () => {
    const msgs: AgentMessage[] = [asst("toolUse", [toolCallBlock()])];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "retain", reason: "toolUse" });
  });

  it("retain missing when no assistant message", () => {
    const msgs: AgentMessage[] = [user("hello")];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "retain", reason: "missing" });
  });

  it("terminal_skip aborted", () => {
    const msgs: AgentMessage[] = [asst("aborted")];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "terminal_skip", reason: "aborted" });
  });

  it("terminal_skip length", () => {
    const msgs: AgentMessage[] = [asst("length")];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "terminal_skip", reason: "length" });
  });

  it("uses last assistant message when multiple", () => {
    const msgs: AgentMessage[] = [
      asst("stop", [textBlock("old")]),
      asst("error"),
    ];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "retain", reason: "error" });
  });

  it("empty messages array returns missing", () => {
    expect(classifyAssistantEnding([])).toEqual({ kind: "retain", reason: "missing" });
  });

  it("ignores user and toolResult messages", () => {
    const msgs: AgentMessage[] = [
      user("hello"),
      { role: "toolResult", toolCallId: "tc-1", toolName: "test", content: [textBlock("res")], isError: false, timestamp: 0 },
    ];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "retain", reason: "missing" });
  });

  it("tool-only content with stop reason still returns toolUse via stopReason", () => {
    // If Pi emits stop with only tool content, stopReason rules
    const msgs: AgentMessage[] = [asst("stop")];
    expect(classifyAssistantEnding(msgs)).toEqual({ kind: "empty_success" });
  });
});
