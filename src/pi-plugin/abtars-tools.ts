import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { checkPiClient, piRequest } from "./abtars-client.js";
import { defineTool, type ToolDefinition, type AgentToolResult, type ExtensionContext } from "./pi-types.js";

function unavailableResult(msg: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text" as const, text: `[abtars] ${msg}` }],
    details: { available: false },
  };
}

function checkAvailability(): { ok: boolean; message?: string } {
  const state = checkPiClient();
  if (!state.available) {
    const msg = state.reason === "no-credential"
      ? "Pi credential not found. Run 'abtars pi authorize' first."
      : "Pi client not available.";
    return { ok: false, message: msg };
  }
  return { ok: true };
}

export function createAbtarsStatusTool(): ToolDefinition {
  return defineTool({
    name: "abtars_status",
    label: "Abtars Status",
    description: "Check if the abtars bridge is reachable, get its version, uptime, and available capabilities.",
    promptSnippet: "Use abtars_status to check if the abtars bridge is running and get version/uptime info.",
    promptGuidelines: [
      "Check bridge availability before using other abtars tools",
    ],
    parameters: Type.Object({}),
    async execute(
      _toolCallId: string, _params: Record<string, unknown>, _signal: AbortSignal | undefined,
      _onUpdate: undefined, _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const avail = checkAvailability();
      if (!avail.ok) return unavailableResult(avail.message!);

      const resp = await piRequest<{ version: string; uptimeSec: number; capabilities: Record<string, boolean> }>(
        "GET", "/v1/pi/status",
      );
      if (resp.ok) {
        const d = resp.data;
        const lines = [
          `Bridge: abtars ${d.version}`,
          `Uptime: ${Math.floor(d.uptimeSec / 60)}m ${d.uptimeSec % 60}s`,
          "Capabilities:",
          `  notify:  ${d.capabilities.notify ? "✅" : "❌"}`,
          `  tasks:   ${d.capabilities.tasks ? "✅" : "❌"}`,
          `  peers:   ${d.capabilities.peers ? "✅" : "❌"}`,
          `  delegate: ${d.capabilities.delegate ? "✅" : "❌"}`,
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { available: true, data: d },
        };
      }
      return {
        content: [{ type: "text", text: `abtars unreachable: ${resp.error.message}` }],
        details: { available: false, error: resp.error },
      };
    },
  });
}

export function createAbtarsNotifyTool(): ToolDefinition {
  return defineTool({
    name: "abtars_notify",
    label: "Abtars Notify",
    description: "Send a text notification to the configured main chat (Telegram/Discord) through the abtars bridge.",
    promptSnippet: "Use abtars_notify to send a message to the operator's main chat channel.",
    promptGuidelines: [
      "Messages are truncated to 4096 characters",
      "Only plain text — no markdown, files, or media",
      "Use for important alerts that need operator attention",
    ],
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 4096, description: "Notification text to send to main chat" }),
    }),
    async execute(
      _toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal | undefined,
      _onUpdate: undefined, _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const avail = checkAvailability();
      if (!avail.ok) return unavailableResult(avail.message!);

      const text = String(params["text"] ?? "").slice(0, 4096);
      const requestId = randomUUID();

      const resp = await piRequest<{ sent: boolean }>("POST", "/v1/pi/notify", { request_id: requestId, text });

      if (resp.ok) {
        return {
          content: [{ type: "text", text: "Notification sent to main chat." }],
          details: { sent: true },
        };
      }

      const msg = resp.error.code === "not_available"
        ? "Main chat not configured on the bridge."
        : resp.error.code === "rate_limited"
        ? "Rate limited. Try again later."
        : `Notify failed: ${resp.error.message}`;

      return {
        content: [{ type: "text", text: msg }],
        details: { sent: false, error: resp.error },
      };
    },
  });
}

export function createAbtarsTaskQueueTool(): ToolDefinition {
  return defineTool({
    name: "abtars_task_queue",
    label: "Abtars Task Queue",
    description: "Queue an asynchronous task for the abtars Orc to process. Returns immediately with a tracking ID.",
    promptSnippet: "Use abtars_task_queue when you need Orc to process something asynchronously in the background.",
    promptGuidelines: [
      "Provide a clear, specific goal describing what to do",
      "Optional context adds background information (up to 16 KiB)",
      "Supply capability requirements to delegate to a capable peer",
      "The task is not inside your own session — it runs independently",
      "Check status later with abtars_task_status",
    ],
    parameters: Type.Object({
      goal: Type.String({ minLength: 1, maxLength: 32768, description: "Task goal — what should Orc do" }),
      context: Type.Optional(Type.String({ maxLength: 16384, description: "Optional background context for the task" })),
      priority: Type.Optional(Type.Union([
        Type.Literal("CRITICAL"),
        Type.Literal("HIGH"),
        Type.Literal("MEDIUM"),
        Type.Literal("LOW"),
      ])),
      delivery: Type.Optional(Type.Union([
        Type.Literal("silent"),
        Type.Literal("deliver"),
        Type.Literal("announce"),
      ])),
    }),
    async execute(
      _toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal | undefined,
      _onUpdate: undefined, _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const avail = checkAvailability();
      if (!avail.ok) return unavailableResult(avail.message!);

      const goal = String(params["goal"] ?? "").slice(0, 32768);
      const context = params["context"] ? String(params["context"]).slice(0, 16384) : undefined;
      const priority = String(params["priority"] ?? "MEDIUM");
      const delivery = String(params["delivery"] ?? "silent");
      const requestId = randomUUID();

      const resp = await piRequest<{ task_id: number; status: string }>(
        "POST", "/v1/pi/tasks",
        { request_id: requestId, goal, context, priority, delivery },
      );

      if (resp.ok) {
        return {
          content: [{ type: "text", text: `Task queued. Tracking ID: ${resp.data.task_id} (status: ${resp.data.status})` }],
          details: { queued: true, taskId: resp.data.task_id },
        };
      }

      return {
        content: [{ type: "text", text: `Task queue failed: ${resp.error.message}` }],
        details: { queued: false, error: resp.error },
      };
    },
  });
}

export function createAbtarsTaskStatusTool(): ToolDefinition {
  return defineTool({
    name: "abtars_task_status",
    label: "Abtars Task Status",
    description: "Check the status of a previously queued abtars task by its tracking ID.",
    promptSnippet: "Use abtars_task_status to check what happened with a queued task.",
    promptGuidelines: [
      "Provide the task ID returned from abtars_task_queue",
      "Only tasks created by the same Pi client are visible",
    ],
    parameters: Type.Object({
      task_id: Type.Integer({ minimum: 1, description: "The task tracking ID from abtars_task_queue" }),
    }),
    async execute(
      _toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal | undefined,
      _onUpdate: undefined, _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const avail = checkAvailability();
      if (!avail.ok) return unavailableResult(avail.message!);

      const taskId = Number(params["task_id"]);

      const resp = await piRequest<{
        task_id: number; status: string; created_at: string;
        completed_at?: string; result_summary?: string; error?: string;
      }>("GET", `/v1/pi/tasks/${taskId}`);

      if (resp.ok) {
        const d = resp.data;
        const lines = [
          `Task #${d.task_id}`,
          `Status: ${d.status}`,
          `Created: ${d.created_at}`,
        ];
        if (d.completed_at) lines.push(`Completed: ${d.completed_at}`);
        if (d.result_summary) lines.push(`Result: ${d.result_summary.slice(0, 500)}`);
        if (d.error) lines.push(`Error: ${d.error.slice(0, 500)}`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: d,
        };
      }

      const msg = resp.error.code === "not_found"
        ? `Task #${taskId} not found or not owned by this client.`
        : `Task status check failed: ${resp.error.message}`;

      return {
        content: [{ type: "text", text: msg }],
        details: { error: resp.error },
      };
    },
  });
}

export function createAbtarsPeerListTool(): ToolDefinition {
  return defineTool({
    name: "abtars_peer_list",
    label: "Abtars Peer List",
    description: "List live peers connected to the abtars bridge, their capability sets, and load.",
    promptSnippet: "Use abtars_peer_list to see what bridge peers are available and their capabilities.",
    promptGuidelines: [
      "Results show name, liveness, load, sessions, and capabilities",
      "No network addresses or credential data are exposed",
      "Use this before abtars_peer_delegate to find capable peers",
    ],
    parameters: Type.Object({
      filter_capability: Type.Optional(Type.String({
        description: "Optional capability filter — only show peers with this capability",
      })),
    }),
    async execute(
      _toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal | undefined,
      _onUpdate: undefined, _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const avail = checkAvailability();
      if (!avail.ok) return unavailableResult(avail.message!);

      const resp = await piRequest<{
        peers: Array<{
          name: string; alive: boolean; lastSeenAge: number | null;
          load: number; sessions: number; capabilities: string[]; version: string;
        }>;
      }>("GET", "/v1/pi/peers");

      if (resp.ok) {
        let peers = resp.data.peers;
        const filterCap = params["filter_capability"];
        if (typeof filterCap === "string" && filterCap) {
          peers = peers.filter(p => p.capabilities.includes(filterCap));
        }

        if (peers.length === 0) {
          return {
            content: [{ type: "text", text: "No peers found." }],
            details: { peers: [] },
          };
        }

        const lines = peers.map(p => {
          const age = p.lastSeenAge !== null
            ? `${Math.floor(p.lastSeenAge / 1000)}s ago` : "unknown";
          const caps = p.capabilities.length > 0 ? p.capabilities.join(", ") : "none";
          return `  ${p.name} ${p.alive ? "🟢" : "🔴"} load=${(p.load * 100).toFixed(0)}% sessions=${p.sessions} last=${age} caps=[${caps}] v=${p.version}`;
        });

        return {
          content: [{ type: "text", text: `Peers (${peers.length}):\n${lines.join("\n")}` }],
          details: { peers },
        };
      }

      return {
        content: [{ type: "text", text: `Peer list failed: ${resp.error.message}` }],
        details: { error: resp.error },
      };
    },
  });
}

export function createAbtarsPeerDelegateTool(): ToolDefinition {
  return defineTool({
    name: "abtars_peer_delegate",
    label: "Abtars Peer Delegate",
    description: "Delegate an asynchronous task to a remote peer bridge. Selects the least-loaded capable peer automatically.",
    promptSnippet: "Use abtars_peer_delegate to offload work to another bridge peer.",
    promptGuidelines: [
      "Provide a clear goal describing what the remote peer should do",
      "Use requirements to specify needed capabilities (e.g. docker, browser)",
      "Specify a target peer with 'peer' to override automatic selection",
      "The task runs asynchronously on the remote bridge",
      "Check abtars_peer_list first to see available peers",
    ],
    parameters: Type.Object({
      goal: Type.String({ minLength: 1, maxLength: 32768, description: "Task goal for the remote peer" }),
      peer: Type.Optional(Type.String({ maxLength: 128, description: "Specific peer name to delegate to (auto-select if omitted)" })),
      context: Type.Optional(Type.String({ maxLength: 16384, description: "Optional background context" })),
      priority: Type.Optional(Type.Union([
        Type.Literal("CRITICAL"),
        Type.Literal("HIGH"),
        Type.Literal("MEDIUM"),
        Type.Literal("LOW"),
      ])),
      requirements: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), {
        maxItems: 20,
        description: "Required peer capabilities (e.g. docker, browser, gpu)",
      })),
    }),
    async execute(
      _toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal | undefined,
      _onUpdate: undefined, _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const avail = checkAvailability();
      if (!avail.ok) return unavailableResult(avail.message!);

      const goal = String(params["goal"] ?? "").slice(0, 32768);
      const peer = params["peer"] ? String(params["peer"]).slice(0, 128) : undefined;
      const context = params["context"] ? String(params["context"]).slice(0, 16384) : undefined;
      const priority = String(params["priority"] ?? "MEDIUM");
      const requirements = Array.isArray(params["requirements"])
        ? (params["requirements"] as string[]).slice(0, 20)
        : undefined;
      const requestId = randomUUID();

      const resp = await piRequest<{
        task_id: number; peer: string; remote_session_id?: string; status: string;
      }>("POST", "/v1/pi/peers/delegate", {
        request_id: requestId, goal, peer, context, priority,
        ...(requirements ? { requirements } : {}),
      });

      if (resp.ok) {
        const d = resp.data;
        const lines = [
          `Delegated to peer: ${d.peer}`,
          `Remote task ID: ${d.task_id}`,
          `Status: ${d.status}`,
        ];
        if (d.remote_session_id) lines.push(`Remote session: ${d.remote_session_id}`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: d,
        };
      }

      const msg = resp.error.code === "no_peers"
        ? "No suitable peer found for delegation."
        : resp.error.code === "rate_limited"
        ? "Rate limited. Try again later."
        : `Delegation failed: ${resp.error.message}`;

      return {
        content: [{ type: "text", text: msg }],
        details: { delegated: false, error: resp.error },
      };
    },
  });
}
