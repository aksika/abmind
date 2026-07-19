import type { AbmindClient } from "../abmind-client.js";
import { AbmindClient as AbmindClientImpl } from "../abmind-client.js";
import type { AbmindCapabilitiesV1 } from "../abmind-protocol.js";
import { LocalTransport } from "../local-transport.js";
import { getAbmindEnv } from "../env-schema.js";
import { logInfo, logWarn, logError } from "../mem-logger.js";

const TAG = "pi-connection";

export interface PiMemoryCapabilities {
  readonly privateRead: boolean;
  readonly privateWrite: boolean;
  readonly methods: readonly string[];
  readonly version: number;
}

export type PiConnectionDegradeCode =
  | "unavailable"
  | "unsupported"
  | "unauthorized"
  | "disabled";

export type PiMemoryConnectionState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "ready"; client: AbmindClient; clientCapabilities: PiMemoryCapabilities }
  | { kind: "degraded"; code: PiConnectionDegradeCode }
  | { kind: "closed" };

export interface PiClientConnection {
  readonly state: PiMemoryConnectionState;
  ensureReady(): Promise<{
    ok: true; client: AbmindClient; capabilities: PiMemoryCapabilities
  } | { ok: false; code: PiConnectionDegradeCode }>;
  close(): Promise<void>;
}

function projectCapabilities(caps: AbmindCapabilitiesV1): PiMemoryCapabilities {
  const privateRead = caps.features?.private_read === "true";
  const privateWrite = caps.features?.private_write === "true";
  return {
    privateRead,
    privateWrite,
    methods: caps.methods ?? [],
    version: caps.version,
  };
}

export function hasMethod(caps: PiMemoryCapabilities, method: string): boolean {
  return caps.methods.includes(method);
}

export function isOperationAvailable(
  operation: "wakeUp" | "recall" | "capture" | "store",
  caps: PiMemoryCapabilities,
): boolean {
  switch (operation) {
    case "wakeUp":
      return caps.privateRead && hasMethod(caps, "private.assembleSessionContext");
    case "recall":
      return caps.privateRead && hasMethod(caps, "private.recall");
    case "capture":
      return hasMethod(caps, "private.recordMessage");
    case "store":
      return caps.privateWrite && hasMethod(caps, "private.instantStore");
  }
}

export function createPiClientConnection(): PiClientConnection {
  let state: PiMemoryConnectionState = { kind: "idle" };
  let connectPromise: Promise<void> | null = null;
  let closePromise_: Promise<void> | null = null;

  function readState(): PiMemoryConnectionState { return state; }

  async function doConnect(): Promise<{
    ok: true; client: AbmindClient; capabilities: PiMemoryCapabilities
  } | { ok: false; code: PiConnectionDegradeCode }> {
    const endpoint = getAbmindEnv().localEndpoint;
    let client: AbmindClient | null = null;
    try {
      const transport = new LocalTransport(endpoint);
      client = new AbmindClientImpl(transport);
      const caps = await client.negotiate();

      if (caps.version !== 1) {
        logWarn(TAG, `Unsupported protocol version ${caps.version}`);
        state = { kind: "degraded", code: "unsupported" };
        await client.close().catch(() => {});
        return { ok: false, code: "unsupported" };
      }

      const capabilities = projectCapabilities(caps);
      state = { kind: "ready", client, clientCapabilities: capabilities };
      logInfo(TAG, `Connected — private_read=${capabilities.privateRead} private_write=${capabilities.privateWrite}`);
      return { ok: true, client, capabilities };
    } catch (err) {
      if (client) {
        await client.close().catch(() => {});
      }
      const msg = (err as Error).message ?? String(err);
      if (msg.includes("ECONNREFUSED") || msg.includes("ENOENT")) {
        logWarn(TAG, `Daemon unavailable: ${msg}`);
        state = { kind: "degraded", code: "unavailable" };
        return { ok: false, code: "unavailable" };
      }
      if (msg.includes("unauthorized") || msg.includes("not authorized")) {
        logWarn(TAG, `Authorization rejected: ${msg}`);
        state = { kind: "degraded", code: "unauthorized" };
        return { ok: false, code: "unauthorized" };
      }
      logWarn(TAG, `Connection failed: ${msg}`);
      state = { kind: "degraded", code: "unavailable" };
      return { ok: false, code: "unavailable" };
    }
  }

  async function ensureReady(): Promise<{
    ok: true; client: AbmindClient; capabilities: PiMemoryCapabilities
  } | { ok: false; code: PiConnectionDegradeCode }> {
    const cur = readState();
    if (cur.kind === "ready") {
      return { ok: true, client: cur.client, capabilities: cur.clientCapabilities };
    }
    if (cur.kind === "connecting") {
      await connectPromise;
      return ensureReady();
    }
    if (cur.kind === "closed") {
      return { ok: false, code: "unavailable" };
    }
    state = { kind: "connecting" };
    connectPromise = doConnect().then(() => {});
    try {
      await connectPromise;
    } finally {
      connectPromise = null;
    }
    const st = readState();
    if (st.kind === "ready") {
      return { ok: true, client: st.client, capabilities: st.clientCapabilities };
    }
    return { ok: false, code: st.kind === "degraded" ? st.code : "unavailable" };
  }

  async function close_(): Promise<void> {
    if (state.kind === "closed") return;
    if (closePromise_) return closePromise_;
    closePromise_ = (async () => {
      const prev = state;
      state = { kind: "closed" };
      if (prev.kind === "ready") {
        await prev.client.close().catch(() => {});
      }
    })();
    return closePromise_;
  }

  return { state, ensureReady, close: close_ };
}
