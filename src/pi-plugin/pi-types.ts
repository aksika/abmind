/**
 * Ambient type declarations for Pi extension API types.
 *
 * These types are provided by the Pi host at runtime via
 * `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`,
 * and `@earendil-works/pi-ai`. We declare them here so the pi-plugin
 * module compiles without those packages installed.
 *
 * At runtime inside Pi, the actual packages supply the real types and
 * values. Standalone abmind must not import this file at the root level.
 */

import type { TSchema } from "@sinclair/typebox";

// ── Extension API ──────────────────────────────────────────────────────

export interface ExtensionAPI {
  on<E = unknown, R = void>(
    event: string,
    handler: (event: E, ctx: ExtensionContext) => R | Promise<R>,
  ): void;
  registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(
    tool: ToolDefinition<TParams, TDetails>,
  ): void;
  sendMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
  events: EventBus;
}

export interface ExtensionContext {
  sessionManager: ReadonlySessionManager;
  signal: AbortSignal | undefined;
  cwd: string;
}

export interface ReadonlySessionManager {
  getSessionId(): string;
}

export interface EventBus {
  emit(event: string, data: unknown): void;
}

// ── Events ──────────────────────────────────────────────────────────────

export interface SessionStartEvent {
  type: "session_start";
  reason: "startup" | "reload" | "new" | "resume" | "fork";
  previousSessionFile?: string;
}

export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  systemPrompt: string;
}

export interface AgentEndEvent {
  type: "agent_end";
  messages: AgentMessage[];
}

export interface SessionShutdownEvent {
  type: "session_shutdown";
  reason: "quit" | "reload" | "new" | "resume" | "fork";
  targetSessionFile?: string;
}

export interface SessionCompactEvent {
  type: "session_compact";
  reason: "manual" | "threshold" | "overflow";
  fromExtension: boolean;
}

// ── Messages ────────────────────────────────────────────────────────────

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCallContent)[];
  stopReason: StopReason;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  timestamp?: number;
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  timestamp: number;
}

export interface CustomMessage<T = unknown> {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent | ThinkingContent)[];
  display: boolean;
  details?: T;
  timestamp: number;
}

export type AgentMessage = AssistantMessage | UserMessage | ToolResultMessage | CustomMessage;

export type ImageContent = { type: "image"; data: string; mimeType: string };

// ── Tools ───────────────────────────────────────────────────────────────

export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;
}

export type AgentToolUpdateCallback<T> = (partialResult: AgentToolResult<T>) => void;

export interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
  terminate?: boolean;
}

export function defineTool<TParams extends TSchema, TDetails = unknown>(
  tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
  return tool;
}
