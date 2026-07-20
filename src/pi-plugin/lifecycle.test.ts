import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerHandlers } from "./index.js";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  SessionStartEvent,
  BeforeAgentStartEvent,
  AgentEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type {
  PiRuntimeState,
  PiRuntime,
} from "./runtime.js";
import {
  beginCapture,
  settleCapture,
  resetCaptureState,
  clearPendingCapture,
} from "./runtime.js";
import type { ExecutionIdentity } from "../host-integration/types.js";
import { createClientLifecycle, type PiMemoryLifecycle } from "./client-lifecycle.js";
import type { PiMemoryConnectionState, PiClientConnection, PiMemoryCapabilities } from "./client-connection.js";

const MOCK_CAPABILITIES: PiMemoryCapabilities = {
  privateRead: true,
  privateWrite: true,
  methods: ["private.assembleSessionContext", "private.recall", "private.recordMessage", "private.instantStore"],
  version: 1,
};

// ── Fake Extension API ─────────────────────────────────────────────────

class FakeSessionManager {
  getSessionId() { return "test-conv-id"; }
}

const testContext: ExtensionContext = {
  sessionManager: new FakeSessionManager() as never,
  signal: undefined,
  cwd: "/tmp",
};

class FakeExtensionAPI implements ExtensionAPI {
  handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown> = new Map();
  toolDefs: ToolDefinition[] = [];
  sentMessages: Array<{ message: unknown; options: unknown }> = [];
  events = { emit: vi.fn() } as never;

  on<E = unknown, R = void>(
    event: string,
    handler: (event: E, ctx: ExtensionContext) => R | Promise<R>,
  ): void {
    this.handlers.set(event, handler as (event: unknown, ctx: ExtensionContext) => unknown);
  }

  registerTool<TParams = unknown, TDetails = unknown>(
    tool: ToolDefinition<TParams, TDetails>,
  ): void {
    this.toolDefs.push(tool as unknown as ToolDefinition);
  }

  sendMessage<T = unknown>(
    message: unknown,
    options?: unknown,
  ): void {
    this.sentMessages.push({ message, options });
  }

  async invoke<E>(event: string, eventData: E): Promise<void> {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`No handler registered for ${event}`);
    await handler(eventData, testContext);
  }
}

// ── Fake PiMemoryLifecycle ────────────────────────────────────────────────

interface FakeLifecycleCall {
  method: string;
  input: unknown;
}

class FakeLifecycle implements PiMemoryLifecycle {
  calls: FakeLifecycleCall[] = [];
  startSessionResult: { ok: boolean; context: string } = { ok: true, context: "wake-up-context" };
  prepareTurnResult = { context: "recall-context", hits: [], diagnostics: [] };
  completeTurnResult:
    | { status: "recorded"; messageIds: number[] }
    | { status: "skipped"; reason: string }
    | { status: "failed"; diagnostic: unknown } = { status: "recorded", messageIds: [1, 2] };

  capability(op: "wakeUp" | "recall" | "capture" | "store"): boolean {
    return true;
  }

  async startSession(input: unknown) {
    this.calls.push({ method: "startSession", input });
    return this.startSessionResult;
  }

  async prepareTurn(input: unknown) {
    this.calls.push({ method: "prepareTurn", input });
    return this.prepareTurnResult;
  }

  async completeTurn(input: unknown) {
    this.calls.push({ method: "completeTurn", input });
    return this.completeTurnResult;
  }

  async recall(_input: unknown) {
    this.calls.push({ method: "recall", input: _input });
    return { context: "", hits: [] };
  }

  async store(_input: unknown) {
    this.calls.push({ method: "store", input: _input });
    return { stored: true, memoriesCount: 1 } as never;
  }

  async close() {}
}

// ── Fake Connection that's always ready ────────────────────────────────────

function makeReadyConnection(): PiClientConnection {
  const mockClient = {} as never;
  const state: PiMemoryConnectionState = {
    kind: "ready",
    client: mockClient,
    clientCapabilities: MOCK_CAPABILITIES,
  };
  return {
    state,
    async ensureReady() {
      return { ok: true, client: mockClient, capabilities: MOCK_CAPABILITIES };
    },
    async close() {},
  };
}

function makeDegradedConnection(): PiClientConnection {
  const state: PiMemoryConnectionState = { kind: "degraded", code: "unavailable" };
  return {
    state,
    async ensureReady() {
      return { ok: false, code: "unavailable" };
    },
    async close() {},
  };
}

/** Lifecycle backed by a real client connection (tests use the connection's ensureReady). */
function makeClientLifecycle(connection: PiClientConnection): PiMemoryLifecycle {
  return createClientLifecycle(connection, "abmind-pi-plugin");
}

function createDegradedRuntime(): PiRuntime {
  const connection = makeDegradedConnection();
  const lifecycle = makeClientLifecycle(connection);
  const state: PiRuntimeState = {
    connection,
    lifecycle,
    identity: null,
    pendingWakeUp: "",
    pendingCapture: null,
    captureGeneration: 0,
    lastSettledCaptureGeneration: -1,
    closed: false,
  };
  return { state, close: async () => { state.closed = true; } };
}

// ── Test Runtime Factory ───────────────────────────────────────────────

function makeTestRuntime(overrides?: Partial<PiRuntimeState>): PiRuntime {
  const connection = overrides?.connection ?? makeReadyConnection();
  const lifecycle = overrides?.lifecycle ?? makeClientLifecycle(connection);
  const state: PiRuntimeState = {
    connection,
    lifecycle,
    identity: null,
    pendingWakeUp: "",
    pendingCapture: null,
    captureGeneration: 0,
    lastSettledCaptureGeneration: -1,
    closed: false,
    ...overrides,
  };
  return {
    state,
    close: async () => { state.closed = true; },
  };
}

// ── Test identity ──────────────────────────────────────────────────────

const testIdentity: ExecutionIdentity = {
  principalId: "test-user",
  conversationId: "test-conv-id",
  executionId: "test-exec-id",
  host: "pi",
  origin: "pi:test",
  automaticWriteOwner: "abmind-pi-plugin",
};

// ── Event helpers ──────────────────────────────────────────────────────

function sessionStartEvent(reason: SessionStartEvent["reason"] = "startup"): SessionStartEvent {
  return { type: "session_start", reason } as SessionStartEvent;
}

function beforeAgentStartEvent(prompt = "user prompt"): BeforeAgentStartEvent {
  return { type: "before_agent_start", prompt, systemPrompt: "system prompt" } as BeforeAgentStartEvent;
}

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

function textBlock(text: string) {
  return { type: "text" as const, text };
}

function agentEndEvent(messages: Message[]): AgentEndEvent {
  return { type: "agent_end", messages } as AgentEndEvent;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("Pi plugin lifecycle", () => {
  let api: FakeExtensionAPI;
  let fakeLifecycle: FakeLifecycle;
  let runtime: PiRuntime;

  beforeEach(() => {
    process.env.ABMIND_USER_ID = "test-user";
    delete process.env.ABMIND_AUTOMATIC_WRITE_OWNER;
    api = new FakeExtensionAPI();
    fakeLifecycle = new FakeLifecycle();
    runtime = makeTestRuntime({
      connection: makeReadyConnection(),
      lifecycle: fakeLifecycle as unknown as PiMemoryLifecycle,
    });
    registerHandlers(api as unknown as ExtensionAPI, runtime);
  });

  // ─── session_start ─────────────────────────────────────────────────

  describe("session_start", () => {
    it.each(["startup", "reload", "new", "resume", "fork"] as const)(
      "sets identity and resets capture state for %s",
      async (reason) => {
        await api.invoke("session_start", sessionStartEvent(reason));
        expect(runtime.state.identity?.principalId).toBe("test-user");
        expect(runtime.state.captureGeneration).toBe(0);
        expect(runtime.state.pendingCapture).toBeNull();
        expect(runtime.state.lastSettledCaptureGeneration).toBe(-1);
      },
    );

    it("obtains one pending wake-up via lifecycle.startSession", async () => {
      await api.invoke("session_start", sessionStartEvent());
      expect(fakeLifecycle.calls.some(c => c.method === "startSession")).toBe(true);
      expect(runtime.state.pendingWakeUp).toBe("wake-up-context");
    });

    it("sets empty wake-up when lifecycle.startSession returns not ok", async () => {
      fakeLifecycle.startSessionResult = { ok: false, context: "" };
      await api.invoke("session_start", sessionStartEvent());
      expect(runtime.state.pendingWakeUp).toBe("");
    });

    it("sets empty wake-up when lifecycle.startSession throws", async () => {
      fakeLifecycle.startSession = async () => { throw new Error("db error"); };
      await api.invoke("session_start", sessionStartEvent());
      expect(runtime.state.pendingWakeUp).toBe("");
    });

    it("sets empty wake-up when degraded (daemon unavailable)", async () => {
      const degRuntime = createDegradedRuntime();
      const degApi = new FakeExtensionAPI();
      registerHandlers(degApi as unknown as ExtensionAPI, degRuntime);
      await degApi.invoke("session_start", sessionStartEvent());
      expect(degRuntime.state.pendingWakeUp).toBe("");
    });
  });

  // ─── before_agent_start ────────────────────────────────────────────

  describe("before_agent_start", () => {
    beforeEach(async () => {
      await api.invoke("session_start", sessionStartEvent());
      fakeLifecycle.calls = [];
      api.sentMessages = [];
    });

    it("increments captureGeneration and sets pendingCapture", async () => {
      expect(runtime.state.captureGeneration).toBe(0);
      await api.invoke("before_agent_start", beforeAgentStartEvent("hello"));
      expect(runtime.state.captureGeneration).toBe(1);
      expect(runtime.state.pendingCapture).toMatchObject({ generation: 1, prompt: "hello" });
    });

    it("replaces pendingCapture from a previous unresolved generation", async () => {
      await api.invoke("before_agent_start", beforeAgentStartEvent("first"));
      expect(runtime.state.pendingCapture).toMatchObject({ generation: 1, prompt: "first" });
      await api.invoke("before_agent_start", beforeAgentStartEvent("second"));
      expect(runtime.state.pendingCapture).toMatchObject({ generation: 2, prompt: "second" });
    });

    it("sends context message with recall results", async () => {
      await api.invoke("before_agent_start", beforeAgentStartEvent("test prompt"));
      expect(api.sentMessages.length).toBeGreaterThanOrEqual(1);
      const msg = api.sentMessages[0]?.message as Record<string, unknown>;
      expect(msg?.customType).toBe("abmind-context");
      expect(msg?.content).toContain("wake-up-context");
      expect(msg?.content).toContain("recall-context");
    });

    it("does not compose context for empty prompt", async () => {
      await api.invoke("before_agent_start", beforeAgentStartEvent(""));
      expect(api.sentMessages).toHaveLength(0);
    });

    it("does not send context when no identity", async () => {
      runtime.state.identity = null;
      await api.invoke("before_agent_start", beforeAgentStartEvent("test"));
      expect(api.sentMessages).toHaveLength(0);
    });

    it("does not send context when degraded (daemon unavailable)", async () => {
      const degRuntime = createDegradedRuntime();
      degRuntime.state.identity = testIdentity;
      const degApi = new FakeExtensionAPI();
      registerHandlers(degApi as unknown as ExtensionAPI, degRuntime);
      await degApi.invoke("before_agent_start", beforeAgentStartEvent("test"));
      expect(degApi.sentMessages).toHaveLength(0);
    });

    it("still sends context with only wake-up when recall fails", async () => {
      fakeLifecycle.prepareTurn = async () => { throw new Error("recall failed"); };
      await api.invoke("before_agent_start", beforeAgentStartEvent("test"));
      expect(api.sentMessages.length).toBeGreaterThanOrEqual(1);
      const msg = api.sentMessages[0]?.message as Record<string, unknown>;
      expect(msg?.content).toContain("wake-up-context");
    });

    it("consumes pendingWakeUp on first turn", async () => {
      expect(runtime.state.pendingWakeUp).toBe("wake-up-context");
      await api.invoke("before_agent_start", beforeAgentStartEvent("first turn"));
      expect(runtime.state.pendingWakeUp).toBe("");
      // Second turn should not have wake-up
      await api.invoke("before_agent_start", beforeAgentStartEvent("second turn"));
      const secondMsg = api.sentMessages[1]?.message as Record<string, unknown>;
      expect(secondMsg?.details).toMatchObject({ wakeUp: false });
    });

    it("still consumes wake-up even when recall fails", async () => {
      fakeLifecycle.prepareTurn = async () => { throw new Error("fail"); };
      await api.invoke("before_agent_start", beforeAgentStartEvent("test"));
      expect(runtime.state.pendingWakeUp).toBe("");
    });

    it("still increments generation and sets pendingCapture for empty prompt", async () => {
      await api.invoke("before_agent_start", beforeAgentStartEvent(""));
      expect(runtime.state.captureGeneration).toBe(1);
      expect(runtime.state.pendingCapture).toMatchObject({ generation: 1, prompt: "" });
    });
  });

  // ─── agent_end ─────────────────────────────────────────────────────

  describe("agent_end", () => {
    beforeEach(async () => {
      await api.invoke("session_start", sessionStartEvent());
      await api.invoke("before_agent_start", beforeAgentStartEvent("original prompt"));
      fakeLifecycle.calls = [];
    });

    it("captures successful stop with text", async () => {
      await api.invoke("agent_end", agentEndEvent([asst("stop", [textBlock("Hello")])]));
      expect(fakeLifecycle.calls.some(c => c.method === "completeTurn")).toBe(true);
      const turnCall = fakeLifecycle.calls.find(c => c.method === "completeTurn");
      const input = turnCall?.input as Record<string, unknown>;
      expect((input?.user as Record<string, unknown>)?.content).toBe("original prompt");
      expect((input?.assistant as Record<string, unknown>)?.content).toBe("Hello");
      expect(runtime.state.pendingCapture).toBeNull();
      expect(runtime.state.lastSettledCaptureGeneration).toBe(1);
    });

    it("retains pendingCapture on error ending", async () => {
      await api.invoke("agent_end", agentEndEvent([asst("error")]));
      expect(fakeLifecycle.calls.some(c => c.method === "completeTurn")).toBe(false);
      expect(runtime.state.pendingCapture).not.toBeNull();
    });

    it("error then success captures the original prompt exactly once", async () => {
      await api.invoke("agent_end", agentEndEvent([asst("error")]));
      expect(fakeLifecycle.calls.some(c => c.method === "completeTurn")).toBe(false);
      expect(runtime.state.pendingCapture).not.toBeNull();

      await api.invoke("agent_end", agentEndEvent([asst("stop", [textBlock("Final answer")])]));
      expect(fakeLifecycle.calls.filter(c => c.method === "completeTurn")).toHaveLength(1);
      const turnCall = fakeLifecycle.calls.find(c => c.method === "completeTurn");
      const input = turnCall?.input as Record<string, unknown>;
      expect((input?.user as Record<string, unknown>)?.content).toBe("original prompt");
      expect(runtime.state.pendingCapture).toBeNull();
    });

    it("multiple errors then success captures once", async () => {
      await api.invoke("agent_end", agentEndEvent([asst("error")]));
      await api.invoke("agent_end", agentEndEvent([asst("error")]));
      await api.invoke("agent_end", agentEndEvent([asst("stop", [textBlock("Done")])]));
      expect(fakeLifecycle.calls.filter(c => c.method === "completeTurn")).toHaveLength(1);
    });

    it("retains pendingCapture on toolUse ending", async () => {
      await api.invoke("agent_end", agentEndEvent([asst("toolUse")]));
      expect(fakeLifecycle.calls.some(c => c.method === "completeTurn")).toBe(false);
      expect(runtime.state.pendingCapture).not.toBeNull();
    });

    it("settles on aborted ending", async () => {
      await api.invoke("agent_end", agentEndEvent([asst("aborted")]));
      expect(fakeLifecycle.calls.some(c => c.method === "completeTurn")).toBe(false);
      expect(runtime.state.pendingCapture).toBeNull();
      expect(runtime.state.lastSettledCaptureGeneration).toBe(1);
    });

    it("settles on length ending", async () => {
      await api.invoke("agent_end", agentEndEvent([asst("length")]));
      expect(fakeLifecycle.calls.some(c => c.method === "completeTurn")).toBe(false);
      expect(runtime.state.pendingCapture).toBeNull();
      expect(runtime.state.lastSettledCaptureGeneration).toBe(1);
    });

    it("settles on empty success ending", async () => {
      await api.invoke("agent_end", agentEndEvent([asst("stop")]));
      expect(fakeLifecycle.calls.some(c => c.method === "completeTurn")).toBe(false);
      expect(runtime.state.pendingCapture).toBeNull();
      expect(runtime.state.lastSettledCaptureGeneration).toBe(1);
    });

    it("ignores duplicate agent_end after settlement", async () => {
      await api.invoke("agent_end", agentEndEvent([asst("stop", [textBlock("First")])]));
      expect(fakeLifecycle.calls.filter(c => c.method === "completeTurn")).toHaveLength(1);
      expect(runtime.state.pendingCapture).toBeNull();

      await api.invoke("agent_end", agentEndEvent([asst("stop", [textBlock("Duplicate")])]));
      expect(fakeLifecycle.calls.filter(c => c.method === "completeTurn")).toHaveLength(1);
    });

    it("does nothing when no pendingCapture", async () => {
      runtime.state.pendingCapture = null;
      await api.invoke("agent_end", agentEndEvent([asst("stop", [textBlock("Orphan")])]));
      expect(fakeLifecycle.calls.some(c => c.method === "completeTurn")).toBe(false);
    });

    it("settles but does not write when no identity", async () => {
      runtime.state.identity = null;
      await api.invoke("agent_end", agentEndEvent([asst("stop", [textBlock("No identity")])]));
      expect(fakeLifecycle.calls.some(c => c.method === "completeTurn")).toBe(false);
      expect(runtime.state.pendingCapture).toBeNull();
      expect(runtime.state.lastSettledCaptureGeneration).toBe(1);
    });

    it("settles but does not write when degraded (daemon unavailable)", async () => {
      const degRuntime = createDegradedRuntime();
      degRuntime.state.identity = testIdentity;
      degRuntime.state.pendingCapture = { generation: 1, prompt: "prompt", userTimestamp: Date.now() };
      degRuntime.state.captureGeneration = 1;
      degRuntime.state.lastSettledCaptureGeneration = -1;
      const degApi = new FakeExtensionAPI();
      registerHandlers(degApi as unknown as ExtensionAPI, degRuntime);
      await degApi.invoke("agent_end", agentEndEvent([asst("stop", [textBlock("Degraded")])]));
      expect(degRuntime.state.pendingCapture).toBeNull();
      expect(degRuntime.state.lastSettledCaptureGeneration).toBe(1);
    });

    it("settles even when lifecycle.completeTurn returns skipped", async () => {
      fakeLifecycle.completeTurnResult = { status: "skipped", reason: "not_owner" };
      await api.invoke("agent_end", agentEndEvent([asst("stop", [textBlock("Skipped")])]));
      expect(runtime.state.pendingCapture).toBeNull();
      expect(runtime.state.lastSettledCaptureGeneration).toBe(1);
    });

    it("settles even when lifecycle.completeTurn returns failed", async () => {
      fakeLifecycle.completeTurnResult = { status: "failed", diagnostic: { operation: "completeTurn", code: "Error", message: "fail" } };
      await api.invoke("agent_end", agentEndEvent([asst("stop", [textBlock("Failed")])]));
      expect(runtime.state.pendingCapture).toBeNull();
      expect(runtime.state.lastSettledCaptureGeneration).toBe(1);
    });

    it("settles even when lifecycle.completeTurn throws", async () => {
      fakeLifecycle.completeTurn = async () => { throw new Error("crash"); };
      await api.invoke("agent_end", agentEndEvent([asst("stop", [textBlock("Crash")])]));
      expect(runtime.state.pendingCapture).toBeNull();
      expect(runtime.state.lastSettledCaptureGeneration).toBe(1);
    });

    it("new prompt replaces unresolved error generation", async () => {
      await api.invoke("agent_end", agentEndEvent([asst("error")]));
      expect(runtime.state.pendingCapture).not.toBeNull();

      await api.invoke("before_agent_start", beforeAgentStartEvent("new prompt"));
      expect(runtime.state.pendingCapture).toMatchObject({ generation: 2, prompt: "new prompt" });

      await api.invoke("agent_end", agentEndEvent([asst("stop", [textBlock("New answer")])]));
      expect(fakeLifecycle.calls.filter(c => c.method === "completeTurn")).toHaveLength(1);
      const turnCall = fakeLifecycle.calls.find(c => c.method === "completeTurn");
      const input = turnCall?.input as Record<string, unknown>;
      expect((input?.user as Record<string, unknown>)?.content).toBe("new prompt");
    });
  });

  // ─── session_compact ───────────────────────────────────────────────

  describe("session_compact", () => {
    beforeEach(async () => {
      await api.invoke("session_start", sessionStartEvent());
    });

    it("is a no-op — does not change capture state", async () => {
      await api.invoke("before_agent_start", beforeAgentStartEvent("test"));
      const gen = runtime.state.captureGeneration;
      const pending = runtime.state.pendingCapture;

      await api.invoke("session_compact", {
        type: "session_compact",
        reason: "manual",
        fromExtension: false,
      } as never);

      expect(runtime.state.captureGeneration).toBe(gen);
      expect(runtime.state.pendingCapture).toBe(pending);
      expect(runtime.state.lastSettledCaptureGeneration).toBe(-1);
      expect(runtime.state.identity).not.toBeNull();
    });
  });

  // ─── session_shutdown ─────────────────────────────────────────────

  describe("session_shutdown", () => {
    beforeEach(async () => {
      await api.invoke("session_start", sessionStartEvent());
      await api.invoke("before_agent_start", beforeAgentStartEvent("test"));
    });

    it("clears capture state, identity, pendingWakeUp, and marks closed", async () => {
      await api.invoke("session_shutdown", {
        type: "session_shutdown",
        reason: "quit",
      } as never);

      expect(runtime.state.captureGeneration).toBe(0);
      expect(runtime.state.pendingCapture).toBeNull();
      expect(runtime.state.lastSettledCaptureGeneration).toBe(-1);
      expect(runtime.state.identity).toBeNull();
      expect(runtime.state.pendingWakeUp).toBe("");
      expect(runtime.state.closed).toBe(true);
    });

    it("repeated shutdown is idempotent — close only once", async () => {
      await api.invoke("session_shutdown", {
        type: "session_shutdown",
        reason: "quit",
      } as never);
      expect(runtime.state.closed).toBe(true);

      await api.invoke("session_shutdown", {
        type: "session_shutdown",
        reason: "quit",
      } as never);
      expect(runtime.state.closed).toBe(true);
    });
  });

  // ─── Runtime state helpers ─────────────────────────────────────────

  describe("runtime state helpers", () => {
    const placeholder: PiMemoryLifecycle = createClientLifecycle(makeDegradedConnection(), "placeholder");

    it("beginCapture increments generation and stores prompt", () => {
      const state: PiRuntimeState = {
        connection: makeReadyConnection(),
        lifecycle: placeholder,
        identity: null,
        pendingWakeUp: "", pendingCapture: null,
        captureGeneration: 0, lastSettledCaptureGeneration: -1, closed: false,
      };
      beginCapture(state, "hello");
      expect(state.captureGeneration).toBe(1);
      expect(state.pendingCapture).toMatchObject({ generation: 1, prompt: "hello" });
    });

    it("settleCapture sets lastSettledCaptureGeneration and clears pendingCapture", () => {
      const state: PiRuntimeState = {
        connection: makeReadyConnection(),
        lifecycle: placeholder,
        identity: null,
        pendingWakeUp: "", pendingCapture: { generation: 5, prompt: "test", userTimestamp: Date.now() },
        captureGeneration: 5, lastSettledCaptureGeneration: -1, closed: false,
      };
      settleCapture(state);
      expect(state.lastSettledCaptureGeneration).toBe(5);
      expect(state.pendingCapture).toBeNull();
    });

    it("settleCapture is a no-op when no pendingCapture", () => {
      const state: PiRuntimeState = {
        connection: makeReadyConnection(),
        lifecycle: placeholder,
        identity: null,
        pendingWakeUp: "", pendingCapture: null,
        captureGeneration: 0, lastSettledCaptureGeneration: -1, closed: false,
      };
      settleCapture(state);
      expect(state.lastSettledCaptureGeneration).toBe(-1);
    });

    it("clearPendingCapture nulls out pendingCapture", () => {
      const state: PiRuntimeState = {
        connection: makeReadyConnection(),
        lifecycle: placeholder,
        identity: null,
        pendingWakeUp: "", pendingCapture: { generation: 3, prompt: "test", userTimestamp: Date.now() },
        captureGeneration: 3, lastSettledCaptureGeneration: -1, closed: false,
      };
      clearPendingCapture(state);
      expect(state.pendingCapture).toBeNull();
      expect(state.captureGeneration).toBe(3); // unchanged
    });

    it("resetCaptureState resets all capture fields", () => {
      const state: PiRuntimeState = {
        connection: makeReadyConnection(),
        lifecycle: placeholder,
        identity: null,
        pendingWakeUp: "", pendingCapture: { generation: 7, prompt: "old", userTimestamp: Date.now() },
        captureGeneration: 7, lastSettledCaptureGeneration: 4, closed: false,
      };
      resetCaptureState(state);
      expect(state.captureGeneration).toBe(0);
      expect(state.pendingCapture).toBeNull();
      expect(state.lastSettledCaptureGeneration).toBe(-1);
    });
  });
});
