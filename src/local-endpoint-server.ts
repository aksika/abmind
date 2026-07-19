import { createServer, type Server, type Socket, createConnection } from "node:net";
import { existsSync, lstatSync, unlinkSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createFrameAccumulator, encodeFrame, decodeFrameHead, CONNECTION_MAX_INFLIGHT, CONNECTION_MAX_QUEUED_WRITES, CONNECTION_IDLE_TIMEOUT_MS, type FrameAccumulator } from "./abmind-frame-codec.js";
import type { AbmindResponseV1, AbmindMethod, AbmindRequestV1, ServiceCallContext, DomainName } from "./abmind-protocol.js";
import { ABMIND_PROTOCOL_VERSION } from "./abmind-protocol.js";
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
  private connPendingWrites = new WeakMap<Socket, number>();
  private stopped = false;

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

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    this.server?.close();
    this.server = null;

    await new Promise<void>((resolve) => {
      const maxWait = 5000;
      const start = Date.now();
      const poll = (): void => {
        if (this.connections.size === 0 || Date.now() - start > maxWait) return resolve();
        setTimeout(() => poll(), 50);
      };
      poll();
      for (const conn of this.connections) {
        try { conn.end(); } catch { /* best effort */ }
      }
    });

    for (const conn of this.connections) {
      try { conn.destroy(); } catch { /* best effort */ }
    }
    this.connections.clear();

    try { unlinkSync(this.socketPath); } catch { /* best effort */ }
    logInfo(TAG, "Endpoint stopped");
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
    this.connPendingWrites.set(conn, 0);
    const acc: FrameAccumulator = createFrameAccumulator();
    const inflight = new Set<string>();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

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
        this.sendError(conn, "", "validation_error", (err as Error).message);
        conn.destroy();
        return;
      }

      let frame: ReturnType<FrameAccumulator["readFrame"]>;
      while ((frame = acc.readFrame()) !== null) {
        resetIdle();

        if (inflight.size >= CONNECTION_MAX_INFLIGHT) {
          this.sendError(conn, "", "unavailable", "Too many in-flight requests");
          continue;
        }

        let request: AbmindRequestV1;
        try {
          const text = frame.payload.toString("utf-8");
          const parsed = JSON.parse(text);
          if (typeof parsed !== "object" || parsed === null) {
            this.sendError(conn, "", "validation_error", "Request must be a JSON object");
            continue;
          }
          request = parsed as AbmindRequestV1;
        } catch {
          this.sendError(conn, "", "validation_error", "Malformed request frame");
          continue;
        }

        if (typeof request.requestId !== "string") {
          this.sendError(conn, "", "validation_error", "Request must have a string requestId");
          continue;
        }
        const requestId = request.requestId;
        inflight.add(requestId);

        const context = this.buildCallContext(conn);

        this.service.handle(request, context).then((response) => {
          inflight.delete(requestId);
          this.sendFrame(conn, response);
        }).catch((err) => {
          inflight.delete(requestId);
          this.sendError(conn, requestId, "unavailable", (err as Error).message);
        });
      }
    });

    conn.on("close", () => {
      if (idleTimer) clearTimeout(idleTimer);
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
          capabilities: new Set(["rebuild_fts"]),
          allowPrivateDelegation: this.allowPrivateDelegation,
          authenticatedBy: "local_peer",
        };
      }
    }
    return {
      principalId: "local-user",
      role: "local_user",
      grantedDomains: new Set(["system", "private", "operational", "operator"]),
      capabilities: new Set(["rebuild_fts"]),
      allowPrivateDelegation: this.allowPrivateDelegation,
      authenticatedBy: "local_peer",
    };
  }

  private sendFrame(conn: Socket, response: AbmindResponseV1): void {
    let pw = this.connPendingWrites.get(conn) ?? 0;
    if (pw >= CONNECTION_MAX_QUEUED_WRITES) {
      try { conn.destroy(); } catch { /* best effort */ }
      return;
    }
    const json = JSON.stringify(response);
    try {
      const frame = encodeFrame(Buffer.from(json, "utf-8"));
      this.connPendingWrites.set(conn, pw + 1);
      conn.write(frame, () => {
        const current = this.connPendingWrites.get(conn) ?? 1;
        this.connPendingWrites.set(conn, Math.max(0, current - 1));
      });
    } catch (err) {
      logError(TAG, "Failed to encode response", err);
    }
  }

  private sendError(conn: Socket, requestId: string, code: string, message: string): void {
    this.sendFrame(conn, {
      ok: false,
      requestId,
      error: { code: code as never, message },
    } as AbmindResponseV1);
  }
}
