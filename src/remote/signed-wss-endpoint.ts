import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { WebSocketServer, type WebSocket } from "ws";
import type { AbmindService } from "../abmind-service.js";
import type { AbmindMethod, AbmindRequestV1, AbmindResponseV1, ServiceCallContext } from "../abmind-protocol.js";
import { METHOD_REGISTRY, RESPONSE_MAX_BYTES } from "../abmind-protocol.js";
import {
  WSS_MAX_RAW_FRAME_BYTES, WSS_MAX_BODY_BYTES, WSS_HANDSHAKE_TIMEOUT_MS,
  WSS_HELLO_CHALLENGE_BYTES, WSS_HELLO_EXPIRY_MS, WSS_MAX_INFLIGHT,
  type SignedAbmindRequestFrameV1, type AbmindResponseFrameV1,
} from "./signed-wire.js";
import { verifyHello, verifyRequestSignature } from "./signed-auth.js";
import { NonceStore } from "./nonce-store.js";
import { RemoteAudit } from "./remote-audit.js";
import { loadEndpointConfig, loadEnrollments, loadGrants, type RemoteEnrollmentV1, type RemoteGrantV1, type RemoteEndpointConfig } from "./remote-config.js";
import { resolveRemoteContext, isMethodAllowed } from "./remote-policy.js";

interface SocketState {
  peerId: string | null;
  generation: string;
  helloChallenge: string;
  helloExpiresAt: number;
  inflight: Set<string>;
}

export class SignedWssEndpoint {
  private service: AbmindService;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private nonceStore: NonceStore;
  private audit: RemoteAudit;
  private enrollments: RemoteEnrollmentV1[] = [];
  private grants: RemoteGrantV1[] = [];
  private config: RemoteEndpointConfig;
  private started = false;

  constructor(service: AbmindService, nonceStore?: NonceStore, audit?: RemoteAudit) {
    this.service = service;
    this.nonceStore = nonceStore ?? new NonceStore();
    this.audit = audit ?? new RemoteAudit();
    this.config = loadEndpointConfig();
    this.enrollments = loadEnrollments();
    this.grants = loadGrants();
  }

  get isStarted(): boolean { return this.started; }

  refreshConfig(): void {
    this.config = loadEndpointConfig();
    this.enrollments = loadEnrollments();
    this.grants = loadGrants();
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!this.config.enabled) return;

    this.refreshConfig();

    const tlsOpts = {
      key: readFileSync(this.config.tlsKeyPath, "utf-8"),
      cert: readFileSync(this.config.tlsCertPath, "utf-8"),
      minVersion: "TLSv1.3" as const,
    };

    this.server = createServer(tlsOpts);
    this.wss = new WebSocketServer({ server: this.server, maxPayload: WSS_MAX_RAW_FRAME_BYTES });

    this.wss.on("connection", (socket) => this.handleConnection(socket));

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        this.started = true;
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.wss) {
      this.wss.clients.forEach(c => c.close(1001, "Server shutdown"));
      this.wss.close();
      this.wss = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private handleConnection(socket: WebSocket): void {
    const state: SocketState = {
      peerId: null,
      generation: randomUUID().slice(0, 12),
      helloChallenge: randomBytes(WSS_HELLO_CHALLENGE_BYTES).toString("hex"),
      helloExpiresAt: Date.now() + WSS_HELLO_EXPIRY_MS,
      inflight: new Set(),
    };

    let helloTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      socket.close(4001, "Hello timeout");
    }, WSS_HANDSHAKE_TIMEOUT_MS);

    const challengeMsg = JSON.stringify({
      type: "challenge", version: 1,
      connectionId: state.generation,
      challenge: state.helloChallenge,
      expiresAt: state.helloExpiresAt,
    });
    socket.send(challengeMsg);

    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const data: Buffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as never);
      if (data.length > WSS_MAX_RAW_FRAME_BYTES) {
        socket.close(1009, "Frame too large");
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString("utf-8"));
      } catch {
        socket.close(4002, "Invalid JSON");
        return;
      }

      if (state.peerId === null) {
        if (helloTimeout) {
          clearTimeout(helloTimeout);
          helloTimeout = null;
        }
        this.handleHello(socket, state, parsed);
      } else {
        this.handleRequest(socket, state, parsed);
      }
    });

    socket.on("close", () => {
      if (helloTimeout) clearTimeout(helloTimeout);
    });

    socket.on("error", () => {});
  }

  private handleHello(socket: WebSocket, state: SocketState, msg: unknown): void {
    const hello = msg as Record<string, unknown>;
    if (hello.type !== "hello" || hello.version !== 1) {
      socket.close(4002, "Invalid hello");
      return;
    }

    const peerId = String(hello.peerId ?? "");
    const connectionId = String(hello.connectionId ?? "");
    const challenge = String(hello.challenge ?? "");
    const timestamp = String(hello.timestamp ?? "");
    const signature = String(hello.signature ?? "");

    if (connectionId !== state.generation) {
      socket.close(4002, "Connection ID mismatch");
      return;
    }
    if (challenge !== state.helloChallenge) {
      socket.close(4002, "Challenge mismatch");
      return;
    }
    if (Date.now() > state.helloExpiresAt) {
      socket.close(4001, "Challenge expired");
      return;
    }

    const enrollment = this.enrollments.find(e => e.peerId === peerId);
    if (!enrollment) {
      socket.close(4003, "Unknown peer");
      return;
    }

    const result = verifyHello(peerId, connectionId, challenge, timestamp, signature, enrollment.verifyKey);
    if (!result.ok) {
      socket.close(4003, `Auth failed: ${result.reason}`);
      return;
    }

    state.peerId = peerId;
    const ack = JSON.stringify({ type: "hello_ack", version: 1, peerId });
    socket.send(ack);
  }

  private async handleRequest(socket: WebSocket, state: SocketState, msg: unknown): Promise<void> {
    if (state.inflight.size >= WSS_MAX_INFLIGHT) {
      this.sendError(socket, "", "too_many_requests", "Max inflight reached");
      return;
    }

    const frame = msg as Record<string, unknown>;
    if (frame.type !== "request" || frame.version !== 1 || frame.method !== "abmind.request.v1") {
      this.sendError(socket, String(frame.id ?? ""), "invalid_frame", "Expected abmind.request.v1");
      return;
    }

    const body = String(frame.body ?? "");
    if (Buffer.byteLength(body, "utf-8") > WSS_MAX_BODY_BYTES) {
      this.sendError(socket, String(frame.id ?? ""), "body_too_large", "Body exceeds max size");
      return;
    }

    const auth = frame.auth as Record<string, string> | undefined;
    if (!auth || !auth.peerId || !auth.ts || !auth.nonce || !auth.sig) {
      this.sendError(socket, String(frame.id ?? ""), "missing_auth", "Missing auth fields");
      return;
    }

    if (auth.peerId !== state.peerId) {
      this.sendError(socket, String(frame.id ?? ""), "auth_mismatch", "Peer ID does not match socket identity");
      return;
    }

    const sigResult = verifyRequestSignature(
      { peerId: auth.peerId, ts: auth.ts, nonce: auth.nonce, sig: auth.sig },
      String(frame.id ?? ""),
      body,
      this.enrollments.find(e => e.peerId === state.peerId!)?.verifyKey ?? "",
    );
    if (!sigResult.ok) {
      this.sendError(socket, String(frame.id ?? ""), `auth_failed:${sigResult.reason}`, "Signature verification failed");
      return;
    }

    const claimResult = this.nonceStore.claim(auth.peerId, auth.nonce);
    if (!claimResult.ok) {
      this.sendError(socket, String(frame.id ?? ""), `nonce:${claimResult.reason}`, "Nonce claim failed");
      return;
    }

    let innerReq: AbmindRequestV1;
    try {
      innerReq = JSON.parse(body);
    } catch {
      this.sendError(socket, String(frame.id ?? ""), "invalid_body", "Body is not valid JSON");
      return;
    }

    if (!innerReq.method || !(innerReq.method in METHOD_REGISTRY)) {
      this.sendError(socket, String(frame.id ?? ""), "unsupported_method", `Unknown method: ${innerReq.method}`);
      return;
    }

    const grant = this.grants.find(g => g.peerId === state.peerId);
    if (!grant) {
      this.sendNonceError(socket, String(frame.id ?? ""), auth.peerId, innerReq.requestId, innerReq.method, body.length);
      return;
    }

    const context = resolveRemoteContext(grant, "signed_peer");
    if (!isMethodAllowed(innerReq.method as AbmindMethod, context)) {
      this.audit.record(this.audit.makeDecisionRecord(
        state.peerId!, grant.principalId, innerReq.requestId, innerReq.method, false, body.length,
      ));
      this.sendError(socket, String(frame.id ?? ""), "unauthorized", `Method not allowed: ${innerReq.method}`);
      return;
    }

    state.inflight.add(innerReq.requestId);
    const decisionRec = this.audit.makeDecisionRecord(
      state.peerId!, grant.principalId, innerReq.requestId, innerReq.method, true, body.length,
    );
    if (!this.audit.record(decisionRec)) {
      this.sendError(socket, String(frame.id ?? ""), "audit_failure", "Audit record failed");
      state.inflight.delete(innerReq.requestId);
      return;
    }

    const startMs = Date.now();
    try {
      const response = await this.service.handle(innerReq as AbmindRequestV1<AbmindMethod>, context);
      state.inflight.delete(innerReq.requestId);

      const respBody = JSON.stringify(response);
      if (Buffer.byteLength(respBody, "utf-8") > RESPONSE_MAX_BYTES) {
        this.sendError(socket, String(frame.id ?? ""), "response_too_large", "Response exceeds max size");
        return;
      }

      const outFrame: AbmindResponseFrameV1 = {
        type: "response", version: 1,
        id: String(frame.id),
        body: respBody,
      };
      this.sendFrame(socket, JSON.stringify(outFrame));

      this.audit.record(this.audit.makeOutcomeRecord(
        decisionRec.auditId, state.peerId!, grant.principalId,
        innerReq.requestId, innerReq.method,
        response.ok ? "ok" : response.error.code,
        Date.now() - startMs, body.length, respBody.length,
      ));
    } catch (err) {
      state.inflight.delete(innerReq.requestId);
      const errMsg = err instanceof Error ? err.message : "Internal error";
      this.sendError(socket, String(frame.id ?? ""), "internal_error", errMsg);
    }
  }

  private sendError(socket: WebSocket, id: string, code: string, message: string): void {
    const body = JSON.stringify({ ok: false, requestId: id, error: { code, message } });
    const resp: AbmindResponseFrameV1 = { type: "response", version: 1, id, body };
    this.sendFrame(socket, JSON.stringify(resp));
  }

  private sendNonceError(socket: WebSocket, frameId: string, peerId: string, requestId: string, method: string, bodyBytes: number): void {
    this.audit.record(this.audit.makeDecisionRecord(peerId, undefined, requestId, method, false, bodyBytes));
    this.sendError(socket, frameId, "no_grant", "Peer has no grant");
  }

  private sendFrame(socket: WebSocket, json: string): void {
    try {
      socket.send(json);
    } catch { /* socket may be closed */ }
  }
}
