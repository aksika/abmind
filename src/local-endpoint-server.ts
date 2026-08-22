import { createServer, type Server, type Socket, createConnection } from "node:net";
import { existsSync, lstatSync, unlinkSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createFrameAccumulator, encodeFrame, decodeFrameHead, CONNECTION_MAX_INFLIGHT, CONNECTION_MAX_QUEUED_WRITES, CONNECTION_IDLE_TIMEOUT_MS, type FrameAccumulator } from "./abmind-frame-codec.js";
import type { AbmindResponseV1, AbmindMethod, AbmindRequestV1, ServiceCallContext, DomainName } from "./abmind-protocol.js";
import { ABMIND_PROTOCOL_VERSION, REQUEST_ID_MAX, errorBodyV1, METHOD_REGISTRY } from "./abmind-protocol.js";
import type { AbmindService } from "./abmind-service.js";
import { getSocketPeerIdentity } from "./local-peer-identity.js";
import { logError, logInfo, logWarn } from "./mem-logger.js";
import { abmindHome } from "./mem-paths.js";

const TAG = "local-endpoint";

export interface LocalEndpointServerConfig {
  socketPath?: string;
  service: AbmindService;
  principalMapping?: "self" | "peer_uid";
  /** Explicitly allow the trusted local host to address configured user IDs. */
  allowPrivateDelegation?: boolean;
}

function defaultSocketPath(): string {
  const runDir = join(abmindHome(), "run");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  return join(runDir, "abmind.sock");
}

export class LocalEndpointServer {
  private server: Server | null = null;
  private readonly socketPath: string;
  private readonly service: AbmindService;
  private readonly principalMapping: "self" | "peer_uid";
  private readonly allowPrivateDelegation: boolean;
  private connections = new Set<Socket>();
  /** #1701: instance-scope queued response writes so final stop can tell completed service dispatch from completed delivery. */
  private pendingWrites = 0;
  private quiesced = false;

  constructor(config: LocalEndpointServerConfig) {
    this.socketPath = config.socketPath ?? defaultSocketPath();
    this.service = config.service;
    this.principalMapping = config.principalMapping ?? "self";
    this.allowPrivateDelegation = config.allowPrivateDelegation ?? false;
  }

  get address(): string { return this.socketPath; }

  async start(): Promise<void> {
    const runDir = join(abmindHome(), "run");
    mkdirSync(runDir, { recursive: true, mode: 0o700 });

    await this.validateExistingEndpoint();

    this.server = createServer((conn) => this.handleConnection(conn));

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.socketPath, () => resolve());
      this.server!.on("error", reject);
    });

    try { chmodSync(this.socketPath, 0o600); } catch { /* best effort */ }

    logInfo(TAG, `Listening on ${this.socketPath}`);
  }

  /**
   * #1701 phase boundary: idempotently stop accepting NEW connections without
   * ending existing sockets or unlinking the endpoint. Because the service is
   * closed before this runs, frames arriving on kept connections receive the
   * existing unavailable response and cannot enter accepted dispatch.
   */
  quiesce(): void {
    if (this.quiesced) return;
    this.quiesced = true;
    this.server?.close();
    this.server = null;
    logInfo(TAG, "Endpoint quiesced");
  }

  /**
   * #1701 final teardown: consumes only the supplied remaining time from the
   * shared shutdown deadline — never mints a fresh hard-coded budget. Queued
   * response writes may flush, then leftovers are destroyed and the Unix
   * socket is removed. `drained` requires BOTH open connections and queued
   * writes to reach zero, so an `inFlight=0` service observation can never be
   * mistaken for delivered-response completion.
   */
  async stop(timeoutMs = 5_000): Promise<{ drained: boolean; remainingConnections: number }> {
    this.quiesce();

    for (const conn of this.connections) {
      try { conn.end(); } catch { /* best effort */ }
    }

    const deadline = Date.now() + Math.max(0, timeoutMs);
    const drained = await new Promise<boolean>((resolve) => {
      const poll = (): void => {
        if (this.connections.size === 0 && this.pendingWrites === 0) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(poll, 25);
      };
      poll();
    });

    const remainingConnections = this.connections.size;
    for (const conn of this.connections) {
      try { conn.destroy(); } catch { /* best effort */ }
    }
    this.connections.clear();

    try { unlinkSync(this.socketPath); } catch { /* best effort */ }
    if (!drained) {
      logWarn(TAG, `Endpoint stop expired with ${remainingConnections} connection(s) and ${this.pendingWrites} queued write(s)`);
    }
    logInfo(TAG, "Endpoint stopped");
    return { drained, remainingConnections };
  }

  private async validateExistingEndpoint(): Promise<void> {
    try {
      const stat = lstatSync(this.socketPath);
      if (!stat.isSocket()) {
        if (stat.isFile() || stat.isSymbolicLink()) {
          throw new Error(`Endpoint path ${this.socketPath} exists and is not a socket`);
        }
        throw new Error(`Endpoint path ${this.socketPath} exists (unknown type)`);
      }
      const live = await this.probeEndpoint();
      if (live) {
        throw new Error(`Endpoint ${this.socketPath} is owned by a live daemon. Stop it first: abmind service stop`);
      }
      logInfo(TAG, `Removing stale endpoint ${this.socketPath}`);
      unlinkSync(this.socketPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  private probeEndpoint(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      try {
        const healthReq = JSON.stringify({
          version: ABMIND_PROTOCOL_VERSION, requestId: "probe", method: "system.health", payload: {},
        });
        const header = Buffer.alloc(4);
        header.writeUInt32BE(healthReq.length);
        const conn = createConnection(this.socketPath);
        const timer = setTimeout(() => { conn.destroy(); resolve(false); }, 3000);
        if (typeof timer === "object" && "unref" in timer) timer.unref();
        const acc = createFrameAccumulator();

        conn.on("connect", () => {
          conn.write(Buffer.concat([header, Buffer.from(healthReq, "utf-8")]));
        });

        conn.on("data", (chunk: Buffer) => {
          try { acc.push(chunk); } catch { return; }
          const frame = acc.readFrame();
          if (frame) {
            clearTimeout(timer);
            conn.destroy();
            try {
              const resp = JSON.parse(frame.payload.toString("utf-8")) as { ok: boolean };
              resolve(resp.ok === true);
            } catch { resolve(false); }
          }
        });
        conn.on("error", () => { clearTimeout(timer); resolve(false); });
        conn.on("close", () => { clearTimeout(timer); resolve(false); });
      } catch { resolve(false); }
    });
  }

  private handleConnection(conn: Socket): void {
    this.connections.add(conn);
    const acc: FrameAccumulator = createFrameAccumulator();
    const inflight = new Set<string>();
    /** requestId → write outcome for delivery observability (#1659). */
    const delivery = new Map<string, { failed: boolean }>();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const socketLabel = `socket=${conn.remoteAddress ?? "local"}`;

    const resetIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (inflight.size === 0) { conn.destroy(); }
      }, CONNECTION_IDLE_TIMEOUT_MS);
      if (idleTimer && typeof idleTimer === "object" && "unref" in idleTimer) idleTimer.unref();
    };
    resetIdle();

    conn.on("data", (chunk: Buffer) => {
      try {
        acc.push(chunk);
      } catch (err) {
        logWarn(TAG, `Malformed frame on ${socketLabel}: ${(err as Error).message}`);
        this.sendError(conn, delivery, "", "validation_error", (err as Error).message);
        conn.destroy();
        return;
      }

      let frame: ReturnType<FrameAccumulator["readFrame"]>;
      while ((frame = acc.readFrame()) !== null) {
        resetIdle();

        // Parse and validate the bounded envelope BEFORE the overflow gate so
        // a parseable request receives its own request ID; the overflow path
        // never calls service.handle().
        let request: AbmindRequestV1;
        let requestId = "";
        try {
          const text = frame.payload.toString("utf-8");
          const parsed = JSON.parse(text);
          if (typeof parsed !== "object" || parsed === null) {
            this.sendError(conn, delivery, "", "validation_error", "Request must be a JSON object");
            continue;
          }
          request = parsed as AbmindRequestV1;
        } catch {
          this.sendError(conn, delivery, "", "validation_error", "Malformed request frame");
          continue;
        }

        if (typeof request.requestId !== "string") {
          this.sendError(conn, delivery, "", "validation_error", "Request must have a string requestId");
          continue;
        }
        requestId = request.requestId;
        if (requestId.length > REQUEST_ID_MAX) {
          this.sendError(conn, delivery, requestId, "validation_error", "Invalid or oversized requestId");
          continue;
        }

        if (inflight.size >= CONNECTION_MAX_INFLIGHT) {
          logWarn(TAG, `Overload on ${socketLabel} requestId=${requestId}: ${inflight.size} in-flight (never dispatched)`);
          this.sendError(conn, delivery, requestId, "unavailable", "Too many in-flight requests");
          continue;
        }
        inflight.add(requestId);

        const context = this.buildCallContext(conn);

        this.service.handle(request, context).then((response) => {
          inflight.delete(requestId);
          if (conn.destroyed) {
            // The client is gone: the response can never be delivered.
            logWarn(TAG, `Response undelivered ${socketLabel} requestId=${requestId}`);
            delivery.delete(requestId);
            return;
          }
          this.sendFrame(conn, delivery, requestId, response);
        }).catch((err) => {
          inflight.delete(requestId);
          // A throw out of handle() happens after the request was admitted:
          // a mutation may have been accepted but its result lost. Never
          // report a possibly-committed mutation as safely retryable.
          const mutation = request.method in METHOD_REGISTRY && METHOD_REGISTRY[request.method as AbmindMethod].mutation === "mutate";
          const detail = err instanceof Error && err.message ? err.message : "no detail";
          const body = mutation
            ? errorBodyV1("outcome_unknown", "Dispatch outcome unknown after acceptance", "response")
            : errorBodyV1("unavailable", detail, "response");
          this.sendFrame(conn, delivery, requestId, { ok: false, requestId, error: body } as AbmindResponseV1);
        });
      }
    });

    conn.on("close", () => {
      if (idleTimer) clearTimeout(idleTimer);
      const undelivered = [...delivery.entries()].filter(([, d]) => !d.failed).map(([requestId]) => requestId);
      if (undelivered.length > 0) {
        logWarn(TAG, `Connection closed with undelivered responses ${socketLabel}: ${undelivered.join(",")}`);
      }
      this.connections.delete(conn);
    });

    conn.on("error", () => {
      this.connections.delete(conn);
    });
  }

  private buildCallContext(conn: Socket): ServiceCallContext {
    if (this.principalMapping === "peer_uid") {
      const peer = getSocketPeerIdentity(conn);
      if (peer) {
        return {
          principalId: `uid-${peer.uid}`,
          role: "local_user",
          grantedDomains: new Set(["system", "private", "operational", "operator"]),
          capabilities: new Set([
            "rebuild_fts", "doctor_diagnose", "doctor_fix",
            "sleep_start", "sleep_status", "sleep_resume", "sleep_cancel",
            "sleep_events", "sleep_runtime_provider",
          ]),
          allowPrivateDelegation: this.allowPrivateDelegation,
          authenticatedBy: "local_peer",
        };
      }
    }
    return {
      principalId: "local-user",
      role: "local_user",
      grantedDomains: new Set(["system", "private", "operational", "operator"]),
      capabilities: new Set([
        "rebuild_fts", "doctor_diagnose", "doctor_fix",
        "sleep_start", "sleep_status", "sleep_resume", "sleep_cancel",
        "sleep_events", "sleep_runtime_provider",
      ]),
      allowPrivateDelegation: this.allowPrivateDelegation,
      authenticatedBy: "local_peer",
    };
  }

  private sendFrame(
    conn: Socket,
    delivery: Map<string, { failed: boolean }>,
    requestId: string,
    response: AbmindResponseV1,
  ): void {
    if (queuedWritesFor(delivery) >= CONNECTION_MAX_QUEUED_WRITES) {
      logError(TAG, `Queued-write limit hit on ${conn.remoteAddress ?? "local"} requestId=${requestId}; destroying socket`);
      try { conn.destroy(); } catch { /* best effort */ }
      return;
    }
    const json = JSON.stringify(response);
    try {
      const frame = encodeFrame(Buffer.from(json, "utf-8"));
      delivery.set(requestId, { failed: false });
      this.pendingWrites++;
      conn.write(frame, (err) => {
        this.pendingWrites--;
        if (err) {
          const entry = delivery.get(requestId);
          if (entry) entry.failed = true;
          logError(TAG, `Write failed for requestId=${requestId} on ${conn.remoteAddress ?? "local"}`, err);
        }
        delivery.delete(requestId);
      });
    } catch (err) {
      logError(TAG, `Failed to encode response for requestId=${requestId}`, err);
      delivery.delete(requestId);
    }
  }

  private sendError(
    conn: Socket,
    delivery: Map<string, { failed: boolean }>,
    requestId: string,
    code: string,
    message: string,
  ): void {
    this.sendFrame(conn, delivery, requestId, {
      ok: false,
      requestId,
      error: errorBodyV1(code as never, message, "pre_dispatch"),
    } as AbmindResponseV1);
  }
}

function queuedWritesFor(delivery: Map<string, { failed: boolean }>): number {
  return delivery.size;
}
