import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import type { AbmindMethod, AbmindRequestV1, AbmindResponseV1, AbmindCapabilitiesV1, AbmindTransport } from "../abmind-protocol.js";
import { ABMIND_PROTOCOL_VERSION } from "../abmind-protocol.js";
import {
  WSS_HANDSHAKE_TIMEOUT_MS, WSS_REQUEST_TIMEOUT_MS,
  WSS_RECONNECT_BASE_MS, WSS_RECONNECT_MAX_MS, WSS_RECONNECT_MAX_ATTEMPTS,
  type AbmindResponseFrameV1, type SignedAbmindRequestFrameV1,
} from "./signed-wire.js";
import { signRequest, signHello, verifyCertificatePin } from "./signed-auth.js";
import { RequestOutbox, OUTBOX_MAX_ATTEMPTS } from "./request-outbox.js";
import type { RemoteClientProfileV1 } from "./remote-config.js";

type WsState = "closed" | "connecting" | "authenticating" | "negotiating" | "ready" | "reconnecting";

interface PendingRequest {
  resolve: (value: AbmindResponseV1) => void;
  timer: ReturnType<typeof setTimeout>;
  frame: string;
  entryId: string;
}

export class SignedWssTransport implements AbmindTransport {
  private profile: RemoteClientProfileV1;
  private socket: WebSocket | null = null;
  private state: WsState = "closed";
  private pending = new Map<string, PendingRequest>();
  private outbox: RequestOutbox;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private capabilities_: AbmindCapabilitiesV1 | null = null;
  private signingKey: string;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(profile: RemoteClientProfileV1, outbox?: RequestOutbox) {
    this.profile = profile;
    this.signingKey = readFileSync(profile.signingKeyPath, "utf-8");
    this.outbox = outbox ?? new RequestOutbox(profile.peerId);
  }

  get capabilities(): AbmindCapabilitiesV1 | null { return this.capabilities_; }

  async negotiate(): Promise<AbmindCapabilitiesV1> {
    if (this.capabilities_) return this.capabilities_;
    await this.connect();
    const resp = await this.sendInner({ method: "system.negotiate", payload: {} });
    if (resp.ok) {
      this.capabilities_ = resp.result as unknown as AbmindCapabilitiesV1;
      return this.capabilities_;
    }
    throw new Error(`Negotiation failed: ${resp.error.message}`);
  }

  async request<K extends AbmindMethod>(req: AbmindRequestV1<K>): Promise<AbmindResponseV1<K>> {
    if (this.closed) {
      return { ok: false, requestId: req.requestId, error: { code: "unavailable", message: "Transport is closed" } } as AbmindResponseV1<K>;
    }
    if (this.state !== "ready") {
      try {
        await this.connect();
      } catch {
        return { ok: false, requestId: req.requestId, error: { code: "unavailable", message: "Connection failed" } } as AbmindResponseV1<K>;
      }
    }
    return this.sendInner(req) as Promise<AbmindResponseV1<K>>;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.capabilities_ = null;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pumpTimer) { clearTimeout(this.pumpTimer); this.pumpTimer = null; }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, requestId: p.entryId, error: { code: "unavailable", message: "Transport closed" } });
    }
    this.pending.clear();
    if (this.socket) {
      try { this.socket.close(); } catch { /* best effort */ }
      this.socket = null;
    }
    this.state = "closed";
  }

  private async connect(): Promise<void> {
    if (this.state === "connecting" || this.state === "authenticating") return;

    this.state = "connecting";
    return new Promise<void>((resolve, reject) => {
      const url = this.profile.url;
      const socket = new WebSocket(url, {
        rejectUnauthorized: false,
        handshakeTimeout: WSS_HANDSHAKE_TIMEOUT_MS,
      });

      let connected = false;

      socket.on("open", () => {
        if (!this.verifyServerPin(socket)) {
          socket.close(4003, "Certificate pin mismatch");
          reject(new Error("Server certificate pin mismatch"));
          return;
        }
        this.socket = socket;
        connected = true;
        this.state = "authenticating";
        this.authenticate(socket).then(resolve).catch(reject);
      });

      socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const data: Buffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as never);
        this.handleMessage(data.toString("utf-8"));
      });

      socket.on("close", () => {
        if (this.socket === socket) {
          this.socket = null;
          this.state = "closed";
          if (!this.closed) this.scheduleReconnect();
        }
        if (!connected) reject(new Error("Connection closed before open"));
      });

      socket.on("error", (err) => {
        if (!connected) reject(err);
      });
    });
  }

  private verifyServerPin(socket: WebSocket): boolean {
    try {
      const cert = (socket as any)._socket?.getPeerCertificate();
      if (!cert || !cert.raw) return false;
      const actualSha256 = createHash("sha256").update(cert.raw).digest("hex");
      return actualSha256 === this.profile.serverCertSha256;
    } catch {
      return false;
    }
  }

  private async authenticate(socket: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) { resolved = true; reject(new Error("Auth timeout")); }
      }, WSS_HANDSHAKE_TIMEOUT_MS);

      const handler = (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const data: Buffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as never);
        const msg = JSON.parse(data.toString("utf-8"));

        if (msg.type === "challenge" && msg.version === 1) {
          const connectionId = msg.connectionId as string;
          const challenge = msg.challenge as string;
          const timestamp = String(Math.floor(Date.now() / 1000));
          const signature = signHello(this.profile.peerId, connectionId, challenge, timestamp, this.signingKey);

          const hello = JSON.stringify({
            type: "hello", version: 1,
            peerId: this.profile.peerId,
            connectionId, challenge, timestamp, signature,
          });
          socket.send(hello);
        } else if (msg.type === "hello_ack") {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            socket.removeListener("message", handler);
            this.state = "ready";
            this.reconnectAttempts = 0;
            this.pumpOutbox();
            resolve();
          }
        }
      };

      socket.on("message", handler);
    });
  }

  private async sendInner(req: { method: string; payload: unknown; requestId?: string; idempotencyKey?: string }): Promise<AbmindResponseV1> {
    const requestId = req.requestId ?? `wss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body = JSON.stringify({ version: ABMIND_PROTOCOL_VERSION, requestId, method: req.method, idempotencyKey: req.idempotencyKey, payload: req.payload });
    const frameId = `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const appended = this.outbox.append(frameId, req.method, requestId, req.idempotencyKey, body, ABMIND_PROTOCOL_VERSION, req.payload);
    if (!appended) {
      return Promise.resolve({ ok: false, requestId, error: { code: "unavailable", message: "Outbox persistence failed" } });
    }

    const auth = signRequest(this.profile.peerId, frameId, body, this.signingKey);
    const frame: SignedAbmindRequestFrameV1 = {
      type: "request", version: 1, id: frameId, method: "abmind.request.v1", body, auth,
    };
    const frameJson = JSON.stringify(frame);

    return new Promise<AbmindResponseV1>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(frameId);
        const attempts = this.outbox.recordAttempt(frameId, "timeout");
        if (attempts !== null && attempts < OUTBOX_MAX_ATTEMPTS) {
          this.scheduleNextPump();
        }
        resolve({ ok: false, requestId, error: { code: "outcome_unknown", message: "Request timeout" } });
      }, WSS_REQUEST_TIMEOUT_MS);

      const pr: PendingRequest = { resolve, timer, frame: frameJson, entryId: frameId };
      this.pending.set(frameId, pr);

      try {
        this.socket?.send(frameJson);
      } catch {
        this.pending.delete(frameId);
        clearTimeout(timer);
        const attempts = this.outbox.recordAttempt(frameId, "send_failed");
        if (attempts !== null && attempts < OUTBOX_MAX_ATTEMPTS) {
          this.scheduleNextPump();
        }
        resolve({ ok: false, requestId, error: { code: "unavailable", message: "Send failed" } });
      }
    });
  }

  private handleMessage(text: string): void {
    try {
      const msg = JSON.parse(text) as AbmindResponseFrameV1;
      if (msg.type !== "response" || msg.version !== 1) return;

      const pending = this.pending.get(msg.id);
      if (!pending) return;

      clearTimeout(pending.timer);
      this.pending.delete(msg.id);

      try {
        const response = JSON.parse(msg.body) as AbmindResponseV1;
        const acked = this.outbox.acknowledge(pending.entryId);
        if (!acked) {
          pending.resolve({ ok: false, requestId: msg.id, error: { code: "unavailable", message: "Outbox ack failed" } });
        } else {
          pending.resolve(response);
        }
      } catch {
        pending.resolve({ ok: false, requestId: msg.id, error: { code: "validation_error", message: "Invalid response body" } });
      }
    } catch { /* ignore malformed frames */ }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectAttempts >= WSS_RECONNECT_MAX_ATTEMPTS) return;
    this.reconnectAttempts++;
    const delay = Math.min(
      WSS_RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1),
      WSS_RECONNECT_MAX_MS,
    );
    this.state = "reconnecting";
    this.reconnectTimer = setTimeout(() => {
      if (this.closed) return;
      this.connect().catch(() => {});
    }, delay);
  }

  private pumpOutbox(): void {
    const entry = this.outbox.peek();
    if (!entry) return;
    const attempts = this.outbox.recordAttempt(entry.id);
    if (attempts !== null && attempts >= OUTBOX_MAX_ATTEMPTS) {
      this.outbox.acknowledge(entry.id);
      return;
    }

    const auth = signRequest(this.profile.peerId, entry.id, entry.body, this.signingKey);
    const frame: SignedAbmindRequestFrameV1 = {
      type: "request", version: 1, id: entry.id, method: "abmind.request.v1", body: entry.body, auth,
    };
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch { /* next pump attempt */ }
  }

  private scheduleNextPump(): void {
    if (this.closed || this.state !== "ready") return;
    if (this.outbox.length === 0) return;
    if (this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      if (this.outbox.length > 0) this.pumpOutbox();
    }, 5000);
  }
}
