/**
 * mcp-server.ts — thin agent-facing MCP adapter over AbmindClient (#1384).
 *
 * Replaces the legacy manager-branching implementation in one cutover: no
 * embedded fallback, no per-call userId, no wakeup/bundle split, no legacy
 * schema adapters. Five tools (memory_recall, memory_store, memory_edit,
 * memory_status, memory_context) route through one typed call wrapper with
 * strict schemas, versioned envelopes, operation-id mutation routing,
 * bounded admission and process cleanup.
 *
 * MCP owns schema validation, routing, result envelopes and process
 * lifecycle. AbmindClient/transports own authentication, grants,
 * negotiation, retry and delivery uncertainty. The owner owns recall,
 * mutation policy, core composition, budgets and MEMORY_TEST.
 */

import { createHash, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AbmindClientError } from "./abmind-client.js";
import { ABMIND_VERSION, ERROR_MESSAGE_MAX, METHOD_REGISTRY, errorContract, type AbmindMethod } from "./abmind-protocol.js";
import { redactSecrets } from "./redact-secrets.js";
import type { ExecutionIdentity } from "./host-integration/types.js";
import {
  McpConnectionOwner, deriveIdempotencyKey, validateInstanceId, validatePrincipal,
  validateOperationId, withMcpTimeout, type McpConnectionMode,
} from "./mcp-connection.js";

export interface McpServerOptions {
  mode: McpConnectionMode;
  socketPath?: string;
  remoteProfile?: string;
  principal: string;
  instanceId: string;
}

/** Bounded startup failure; the CLI renders it on stderr with nonzero exit. */
export class McpStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpStartupError";
  }
}

type ToolName = "memory_recall" | "memory_store" | "memory_edit" | "memory_status" | "memory_context";

const TOOL_NAMES: readonly ToolName[] = [
  "memory_recall", "memory_store", "memory_edit", "memory_status", "memory_context",
];

/** Tool dependencies: negotiated owner methods plus feature gates. */
const TOOL_DEPS: Record<ToolName, { methods: AbmindMethod[]; features?: Record<string, string> }> = {
  memory_recall: { methods: ["private.lifecycleRecall"] },
  memory_store: {
    methods: ["private.lifecycleStore"],
    features: { private_write: "true", private_mutation_contract: "revision-v1" },
  },
  memory_edit: {
    methods: ["private.adjustRelevance"],
    features: { private_write: "true", private_mutation_contract: "revision-v1" },
  },
  memory_status: { methods: ["private.getRuntimeStatus"] },
  memory_context: { methods: ["private.modelContext"] },
};

const MAX_CONCURRENT_CALLS = 16;
const SHUTDOWN_DRAIN_MS = 5_000;

const NONBLANK = (s: string): boolean => s.trim().length > 0;
const CONTROL_CHAR = /[\x00-\x1f\x7f-\x9f]/;
const OPERATION_ID = z.string().min(1).max(128)
  .refine((s) => !CONTROL_CHAR.test(s), "operationId must not contain control characters");

// ── SDK-level input schemas ─────────────────────────────────────────────
// Permissive on values (every declared field optional, unknown fields kept
// via catchall) so all value errors reach the handler and become bounded
// validation_error envelopes. Gross type mismatches are rejected by the
// SDK's protocol machinery before the handler runs.

const SdkRecallInput = z.object({
  keywords: z.array(z.string()).optional(),
  original: z.string().optional(),
  limit: z.number().optional(),
  maxClassification: z.number().optional(),
}).catchall(z.unknown());

const SdkStoreInput = z.object({
  text: z.string().optional(),
  memoryType: z.string().optional(),
  operationId: z.string().optional(),
  original: z.string().optional(),
}).catchall(z.unknown());

const SdkEditInput = z.object({
  memoryId: z.number().optional(),
  expectedRevision: z.number().optional(),
  action: z.string().optional(),
  operationId: z.string().optional(),
}).catchall(z.unknown());

const SdkEmptyInput = z.object({}).catchall(z.unknown()).optional();

// ── Strict adapter schemas: unknown fields rejected, no silent clamping ──

const StrictRecallInput = z.object({
  keywords: z.array(z.string().refine(NONBLANK, "keywords must be nonblank")).min(1).max(50),
  original: z.string().refine(NONBLANK, "original must be nonblank").optional(),
  limit: z.number().int().min(1).max(50).optional(),
  maxClassification: z.number().int().min(0).max(2).optional(),
}).strict();

const StrictStoreInput = z.object({
  text: z.string().refine(NONBLANK, "text must be nonblank"),
  memoryType: z.enum(["fact", "preference", "decision", "event"]),
  operationId: OPERATION_ID,
  original: z.string().refine(NONBLANK, "original must be nonblank").optional(),
}).strict();

const StrictEditInput = z.object({
  memoryId: z.number().int().positive(),
  expectedRevision: z.number().int().positive(),
  action: z.enum(["boost", "demote"]),
  operationId: OPERATION_ID,
}).strict();

const StrictEmptyInput = z.object({}).strict();

const EnvelopeOutputSchema = z.object({
  version: z.literal(1),
  ok: z.boolean(),
  operationId: z.string().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

interface McpErrorBody {
  code: string;
  message: string;
  requestId?: string;
  retryable: boolean;
  action: string;
  stage: string;
  current?: unknown;
}

function boundMessage(raw: string): string {
  const redacted = redactSecrets(raw);
  return redacted.length <= ERROR_MESSAGE_MAX ? redacted : `${redacted.slice(0, ERROR_MESSAGE_MAX - 3)}...`;
}

function validationError(message: string): McpErrorBody {
  return { code: "validation_error", message: boundMessage(message), retryable: false, action: "fix_input", stage: "pre_dispatch" };
}

function ownerErrorBody(err: AbmindClientError): McpErrorBody {
  const body: McpErrorBody = {
    code: err.code,
    message: err.message,
    retryable: err.retryable,
    action: err.action,
    stage: err.stage,
  };
  if (err.requestId) body.requestId = err.requestId;
  if (err.current !== undefined) body.current = err.current;
  return body;
}

/** Owner wire byte limits apply; oversized input is rejected before dispatch. */
function checkWireSize(method: AbmindMethod, payload: unknown): string | null {
  const entry = METHOD_REGISTRY[method];
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(payload) ?? "", "utf-8");
  } catch {
    return `${method} payload is not JSON-serializable`;
  }
  return bytes > entry.maxInputBytes
    ? `${method} payload exceeds ${entry.maxInputBytes} bytes`
    : null;
}

function isMcpTimeout(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("MCP wait exceeded");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function diagStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

export async function startMcpServer(options: McpServerOptions): Promise<void> {
  const principal = validatePrincipal(options.principal);
  const instanceId = validateInstanceId(options.instanceId);
  // Immutable connection provenance: derived once from the configured
  // instance and principal so every call from this MCP host configuration
  // carries identical identity fields across process restarts. That is what
  // lets an exact retry (same operation id, same input) resend the identical
  // wire payload and converge on the owner ledger instead of conflicting
  // with itself after a crash; changed input still conflicts.
  const connectionId = createHash("sha256")
    .update(`mcp-connection\0${instanceId}\0${principal}`, "utf-8")
    .digest("hex")
    .slice(0, 32);
  const noAutoWrite = `mcp:${connectionId}:no-auto-write`;

  const owner = new McpConnectionOwner({
    mode: options.mode,
    socketPath: options.socketPath,
    remoteProfile: options.remoteProfile,
    principal,
    instanceId,
  });
  try {
    await withMcpTimeout(owner.start());
  } catch (err) {
    await owner.close().catch(() => {});
    throw new McpStartupError(boundMessage(err instanceof Error ? err.message : String(err)));
  }

  const newIdentity = (executionId?: string): ExecutionIdentity => ({
    principalId: principal,
    conversationId: connectionId,
    // Writes derive the execution from the caller-chosen operation id so an
    // exact retry resends the identical wire payload and converges on the
    // ledger instead of conflicting with itself; every new intended change
    // needs a new id and therefore a new execution. Reads carry no
    // operation id and get a unique id per call.
    executionId: executionId ?? randomUUID(),
    host: "mcp",
    origin: "agent",
    automaticWriteOwner: noAutoWrite,
  });

  const server = new McpServer({ name: "abmind", version: ABMIND_VERSION });
  const registered = new Map<ToolName, RegisteredTool>();

  // ── Admission, readiness, dependency state ──
  let accepting = true;
  let activeCalls = 0;
  const inFlight = new Set<Promise<unknown>>();
  let renegotiating: Promise<boolean> | null = null;

  const toolAvailable = (tool: ToolName): boolean => {
    const caps = owner.capabilities;
    if (!caps) return false;
    const deps = TOOL_DEPS[tool];
    if (!deps.methods.every((m) => caps.methods.includes(m))) return false;
    if (deps.features) {
      for (const [k, v] of Object.entries(deps.features)) {
        if (caps.features[k] !== v) return false;
      }
    }
    return true;
  };

  const refreshTools = (): void => {
    let changed = false;
    for (const [name, handle] of [...registered]) {
      if (!toolAvailable(name)) {
        // Revoked methods disappear; the SDK notifies list_changed.
        handle.remove();
        registered.delete(name);
        changed = true;
      }
    }
    for (const name of TOOL_NAMES) {
      if (toolAvailable(name) && !registered.has(name)) {
        registered.set(name, registerTool(name));
        changed = true;
      }
    }
    if (changed) {
      try {
        server.sendToolListChanged();
      } catch { /* not connected or already closed */ }
    }
  };

  const ensureNegotiated = async (): Promise<boolean> => {
    if (owner.isRouteReady()) return true;
    if (!renegotiating) {
      renegotiating = (async (): Promise<boolean> => {
        try {
          await owner.renegotiate();
          refreshTools();
          return true;
        } catch {
          return false;
        } finally {
          renegotiating = null;
        }
      })();
    }
    return renegotiating;
  };

  // ── Envelope results ──
  type ToolResult = { content: [{ type: "text"; text: string }]; structuredContent: Record<string, unknown>; isError?: boolean };

  const okResult = (result: unknown, operationId?: string): ToolResult => {
    const envelope: Record<string, unknown> = { version: 1, ok: true, result };
    if (operationId !== undefined) envelope.operationId = operationId;
    return {
      content: [{ type: "text", text: JSON.stringify(envelope) }],
      structuredContent: envelope,
    };
  };

  const errResult = (error: McpErrorBody, operationId?: string): ToolResult => {
    const envelope: Record<string, unknown> = { version: 1, ok: false, error };
    if (operationId !== undefined) envelope.operationId = operationId;
    return {
      content: [{ type: "text", text: JSON.stringify(envelope) }],
      structuredContent: envelope,
      isError: true,
    };
  };

  const failResult = (error: McpErrorBody): ToolResult => errResult(error);

  // ── One typed call wrapper ──
  const runGuarded = async (
    tool: ToolName,
    dispatch: () => Promise<ToolResult>,
  ): Promise<ToolResult> => {
    if (!accepting) {
      return failResult({ code: "unavailable", message: "MCP server is shutting down", retryable: false, action: "stop", stage: "pre_dispatch" });
    }
    if (!await ensureNegotiated()) {
      return failResult({ code: "unavailable", message: "Owner route is not ready", retryable: true, action: "retry", stage: "pre_dispatch" });
    }
    // Recheck dependencies for each call so revoked methods fail even if
    // the host cached an earlier schema.
    if (!toolAvailable(tool)) {
      return failResult({ code: "unsupported_method", message: `Tool ${tool} is not supported by the current owner`, retryable: false, action: "fix_input", stage: "pre_dispatch" });
    }
    if (activeCalls >= MAX_CONCURRENT_CALLS) {
      return failResult({ code: "busy", message: "Too many concurrent MCP calls", retryable: true, action: "retry", stage: "pre_dispatch" });
    }
    activeCalls++;
    let task!: Promise<ToolResult>;
    task = (async (): Promise<ToolResult> => {
      try {
        return await dispatch();
      } finally {
        activeCalls--;
        inFlight.delete(task);
      }
    })();
    inFlight.add(task);
    try {
      return await withMcpTimeout(task);
    } catch (err) {
      if (isMcpTimeout(err)) {
        // Fence delivery: the late result is dropped when it settles and
        // can never land in a later call. The slot stays occupied until
        // the underlying dispatch settles — a timeout never frees it for
        // unlimited replacements.
        const mutation = tool === "memory_store" || tool === "memory_edit";
        if (mutation) {
          return failResult({ code: "outcome_unknown", message: "MCP call timed out; mutation outcome is unknown, reconcile before retrying with a new operation id", retryable: false, action: "reconcile", stage: "response" });
        }
        return failResult({ code: "unavailable", message: "MCP call timed out", retryable: true, action: "retry", stage: "response" });
      }
      throw err;
    }
  };

  // ── Tool handlers: direct typed owner calls, no raw-method dispatcher ──
  const handleRecall = async (raw: unknown): Promise<ToolResult> => {
    const parsed = StrictRecallInput.safeParse(raw);
    if (!parsed.success) return failResult(validationError(parsed.error.issues[0]?.message ?? "invalid memory_recall input"));
    const { keywords, original, limit, maxClassification } = parsed.data;
    const payload = {
      identity: newIdentity(),
      query: { translated: [...keywords], ...(original !== undefined ? { original } : {}) },
      limit: limit ?? 10,
      maxClassification: maxClassification ?? 2,
    };
    const recallSizeError = checkWireSize("private.lifecycleRecall", payload);
    if (recallSizeError) return failResult(validationError(recallSizeError));
    try {
      const res = await owner.client.lifecycle.recall(payload);
      return okResult({ context: res.context, hits: res.hits, rendered: res.rendered, diagnostics: res.diagnostics });
    } catch (err) {
      if (err instanceof AbmindClientError) return failResult(ownerErrorBody(err));
      return failResult({ code: "unavailable", message: boundMessage(err instanceof Error ? err.message : String(err)), retryable: true, action: "retry", stage: "response" });
    }
  };

  const handleStore = async (raw: unknown): Promise<ToolResult> => {
    const parsed = StrictStoreInput.safeParse(raw);
    if (!parsed.success) return failResult(validationError(parsed.error.issues[0]?.message ?? "invalid memory_store input"));
    const { text, memoryType, operationId, original } = parsed.data;
    const opId = validateOperationId(operationId);
    const key = deriveIdempotencyKey(instanceId, principal, "memory_store", opId);
    const payload = {
      identity: newIdentity(`memory_store:${opId}`),
      contentEn: text,
      contentOriginal: original ?? text,
      memoryType,
      emotionScore: 0,
      classification: 1,
    };
    const storeSizeError = checkWireSize("private.lifecycleStore", payload);
    if (storeSizeError) return errResult(validationError(storeSizeError), opId);
    try {
      const receipt = await owner.client.lifecycle.store(payload, key);
      if (!receipt.stored) {
        // A typed rejected receipt is a failed tool operation despite a
        // successful RPC envelope. Preserve the owner code/message.
        const contract = errorContract(receipt.code);
        return errResult({
          code: receipt.code, message: boundMessage(receipt.message),
          retryable: contract.retryable, action: contract.action, stage: "dispatch",
        }, opId);
      }
      return okResult(receipt, opId);
    } catch (err) {
      if (err instanceof AbmindClientError) {
        if (err.code === "outcome_unknown") {
          return errResult({ ...ownerErrorBody(err), retryable: false, action: "reconcile" }, opId);
        }
        return errResult(ownerErrorBody(err), opId);
      }
      // A dispatched mutation without a definitive result is conservatively
      // outcome_unknown/reconcile — never safe to repeat, never rollback.
      return errResult({ code: "outcome_unknown", message: boundMessage(err instanceof Error ? err.message : String(err)), retryable: false, action: "reconcile", stage: "response" }, opId);
    }
  };

  const handleEdit = async (raw: unknown): Promise<ToolResult> => {
    const parsed = StrictEditInput.safeParse(raw);
    if (!parsed.success) return failResult(validationError(parsed.error.issues[0]?.message ?? "invalid memory_edit input"));
    const { memoryId, expectedRevision, action, operationId } = parsed.data;
    const opId = validateOperationId(operationId);
    const key = deriveIdempotencyKey(instanceId, principal, "memory_edit", opId);
    const payload = {
      userId: principal,
      memoryId,
      expectedRevision,
      delta: action === "boost" ? 10 : -10,
    };
    const editSizeError = checkWireSize("private.adjustRelevance", payload);
    if (editSizeError) return errResult(validationError(editSizeError), opId);
    try {
      const receipt = await owner.client.privateMemory.adjustRelevance(payload, key);
      return okResult(receipt, opId);
    } catch (err) {
      if (err instanceof AbmindClientError) {
        if (err.code === "outcome_unknown") {
          return errResult({ ...ownerErrorBody(err), retryable: false, action: "reconcile" }, opId);
        }
        return errResult(ownerErrorBody(err), opId);
      }
      return errResult({ code: "outcome_unknown", message: boundMessage(err instanceof Error ? err.message : String(err)), retryable: false, action: "reconcile", stage: "response" }, opId);
    }
  };

  const handleStatus = async (raw: unknown): Promise<ToolResult> => {
    const parsed = StrictEmptyInput.safeParse(raw ?? {});
    if (!parsed.success) return failResult(validationError(parsed.error.issues[0]?.message ?? "invalid memory_status input"));
    try {
      const receipt = await owner.client.privateMemory.getRuntimeStatus({ userId: principal }) as Record<string, unknown> | null;
      // A null/unavailable runtime-status receipt is an operation failure,
      // not fabricated zero statistics.
      if (receipt === null || receipt === undefined) {
        return failResult({ code: "unavailable", message: "Owner runtime status is unavailable", retryable: true, action: "retry", stage: "dispatch" });
      }
      const projected: Record<string, unknown> = {};
      for (const field of ["totalMessages", "extractedMemories", "extractedByType", "consolidationFiles", "ingestedDocuments", "preservedKeywords", "dbSizeBytes", "rejectedByScanner", "memoryTest"]) {
        if (receipt[field] !== undefined) projected[field] = receipt[field];
      }
      const snap = owner.routeSnapshot;
      const result: Record<string, unknown> = {
        ...projected,
        connection: { mode: owner.mode, principal, route: snap.state },
      };
      const counts = owner.outboxCounts();
      if (counts) result.outbox = { ...counts };
      return okResult(result);
    } catch (err) {
      if (err instanceof AbmindClientError) return failResult(ownerErrorBody(err));
      return failResult({ code: "unavailable", message: boundMessage(err instanceof Error ? err.message : String(err)), retryable: true, action: "retry", stage: "response" });
    }
  };

  const handleContext = async (raw: unknown): Promise<ToolResult> => {
    const parsed = StrictEmptyInput.safeParse(raw ?? {});
    if (!parsed.success) return failResult(validationError(parsed.error.issues[0]?.message ?? "invalid memory_context input"));
    try {
      const res = await owner.client.privateMemory.modelContext({ userId: principal });
      return okResult({ text: res.text, memoryTest: res.memoryTest });
    } catch (err) {
      if (err instanceof AbmindClientError) return failResult(ownerErrorBody(err));
      return failResult({ code: "unavailable", message: boundMessage(err instanceof Error ? err.message : String(err)), retryable: true, action: "retry", stage: "response" });
    }
  };

  const TOOL_HANDLERS: Record<ToolName, (raw: unknown) => Promise<ToolResult>> = {
    memory_recall: handleRecall,
    memory_store: handleStore,
    memory_edit: handleEdit,
    memory_status: handleStatus,
    memory_context: handleContext,
  };

  const TOOL_META: Record<ToolName, { description: string; inputSchema: z.ZodTypeAny; annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean } }> = {
    memory_recall: {
      description: "Deliberately recall persistent memories by keywords from the configured abmind owner. Always searches; common words still search. Returns owner context, hits with eligible source/revision refs, and diagnostics. SECRET content never appears.",
      inputSchema: SdkRecallInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    memory_store: {
      description: "Store a fact, preference, decision, or event under the bound principal. Requires a caller-chosen operationId (1-128 chars): repeating the same operationId with the same payload converges; changed input under a reused id conflicts. Returns the actual store receipt.",
      inputSchema: SdkStoreInput,
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    memory_edit: {
      description: "Boost (+10) or demote (-10) a memory's relevance. Requires the current semantic revision and a caller-chosen operationId. Stale revisions and foreign rows fail without changes.",
      inputSchema: SdkEditInput,
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    memory_status: {
      description: "Inspect bound-principal runtime status plus connection mode; in remote mode, bounded retry-eligible and terminal-unknown outbox counts for reconciliation. Never exposes paths, credentials, or row contents.",
      inputSchema: SdkEmptyInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    memory_context: {
      description: "Request the owner-composed model context (core knowledge including core facts, plus wakeup; no conversation history). Contents depend on configured files and test mode: with MEMORY_TEST=ON in the owner only tool instructions and computed time remain. Primary memory owner only.",
      inputSchema: SdkEmptyInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  };

  function registerTool(name: ToolName): RegisteredTool {
    const meta = TOOL_META[name];
    const handler = TOOL_HANDLERS[name];
    return server.registerTool(name, {
      description: meta.description,
      inputSchema: meta.inputSchema,
      outputSchema: EnvelopeOutputSchema,
      annotations: meta.annotations,
    }, async (args: unknown) => runGuarded(name, () => handler(args)));
  }

  for (const name of TOOL_NAMES) {
    if (toolAvailable(name)) registered.set(name, registerTool(name));
  }

  // ── Process lifecycle: the entry owns stdin/signals/shutdown ──
  const transport = new StdioServerTransport();
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  let shutdownPromise: Promise<void> | null = null;

  const doShutdown = async (reason: string): Promise<void> => {
    accepting = false;
    diagStderr(`abmind mcp shutting down: ${reason}`);
    try {
      await Promise.race([Promise.allSettled([...inFlight]), delay(SHUTDOWN_DRAIN_MS)]);
    } finally {
      await owner.close();
    }
    try {
      await transport.close();
    } catch { /* best effort */ }
  };

  const requestShutdown = (reason: string): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = doShutdown(reason).then(
        () => { resolveDone(); },
        () => { resolveDone(); },
      );
    }
    return shutdownPromise;
  };

  transport.onclose = (): void => {
    void requestShutdown("transport closed");
  };
  process.stdin.on("end", () => {
    void requestShutdown("stdin EOF");
  });
  process.stdin.on("close", () => {
    void requestShutdown("stdin closed");
  });
  const onSignal = (signal: string): void => {
    void requestShutdown(signal).then(() => process.exit(0));
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  // Stdout is exclusively MCP frames. Startup diagnostics stay on stderr.
  // The finally guarantees the transport and remote lease are released on
  // every exit path (normal shutdown closes them first; close() is one
  // shared idempotent cleanup).
  try {
    await server.connect(transport);
    diagStderr(`abmind mcp serving ${registered.size} tools over ${options.mode} (principal ${principal}, instance ${instanceId})`);
    await done;
  } finally {
    await owner.close().catch(() => {});
    try {
      await transport.close();
    } catch { /* best effort */ }
  }
}
