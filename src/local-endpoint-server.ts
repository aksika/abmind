import { createServer, type Server, type Socket } from "node:net";
import { existsSync, lstatSync, unlinkSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createFrameAccumulator, encodeFrame, REQUEST_TIMEOUT_MS, CONNECTION_MAX_INFLIGHT, CONNECTION_MAX_QUEUED_WRITES, CONNECTION_IDLE_TIMEOUT_MS, type FrameAccumulator } from "./abmind-frame-codec.js";
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
  private connections = new Set<Socket>();
  private stopped = false;

  constructor(config: LocalEndpointServerConfig) {
    this.socketPath = config.socketPath ?? defaultSocketPath();
    this.service = config.service;
    this.principalMapping = config.principalMapping ?? "self";
  }

  get address(): string { return this.socketPath; }

  async start(): Promise<void> {
    const runDir = join(abmindHome(), "run");
    mkdirSync(runDir, { recursive: true, mode: 0o700 });

    this.validateExistingEndpoint();

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

    for (const conn of this.connections) {
      try { conn.destroy(); } catch { /* best effort */ }
    }
    this.connections.clear();

    try { unlinkSync(this.socketPath); } catch { /* best effort */ }
    logInfo(TAG, "Endpoint stopped");
  }

  private validateExistingEndpoint(): void {
    try {
      const stat = lstatSync(this.socketPath);
      if (!stat.isSocket()) {
        if (stat.isFile() || stat.isSymbolicLink()) {
          throw new Error(`Endpoint path ${this.socketPath} exists and is not a socket`);
        }
        throw new Error(`Endpoint path ${this.socketPath} exists (unknown type)`);
      }
      unlinkSync(this.socketPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
  }

  private handleConnection(conn: Socket): void {
    this.connections.add(conn);
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
          request = JSON.parse(text);
        } catch {
          this.sendError(conn, "", "validation_error", "Malformed request frame");
          continue;
        }

        const requestId = request.requestId ?? randomUUID().slice(0, 8);
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
          grantedDomains: new Set(["system", "private", "operational"]),
          authenticatedBy: "local_peer",
        };
      }
    }
    return {
      principalId: "local-user",
      role: "local_user",
      grantedDomains: new Set(["system", "private", "operational"]),
      authenticatedBy: "local_peer",
    };
  }

  private sendFrame(conn: Socket, response: AbmindResponseV1): void {
    const json = JSON.stringify(response);
    try {
      const frame = encodeFrame(Buffer.from(json, "utf-8"));
      conn.write(frame);
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
