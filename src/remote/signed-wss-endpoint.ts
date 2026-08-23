import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { WebSocketServer, type WebSocket } from "ws";
import type { AbmindService } from "../abmind-service.js";
import type { AbmindMethod, AbmindRequestV1 } from "../abmind-protocol.js";
import { METHOD_REGISTRY, REQUEST_ID_MAX, RESPONSE_MAX_BYTES } from "../abmind-protocol.js";
import {
  WSS_MAX_RAW_FRAME_BYTES, WSS_MAX_BODY_BYTES, WSS_HANDSHAKE_TIMEOUT_MS,
  WSS_HELLO_CHALLENGE_BYTES, WSS_HELLO_EXPIRY_MS, WSS_MAX_INFLIGHT,
  WSS_IDLE_TIMEOUT_MS, WSS_MAX_QUEUED_WRITE_BYTES, WSS_FRAME_ID_MAX,
  type AbmindResponseFrameV1,
} from "./signed-wire.js";
import { verifyHello, verifyRequestSignature } from "./signed-auth.js";
import { NonceStore } from "./nonce-store.js";
import { RemoteAudit } from "./remote-audit.js";
import { loadEndpointConfig, loadEnrollments, loadGrants, type RemoteEnrollmentV1, type RemoteGrantV1, type RemoteEndpointConfig } from "./remote-config.js";
import { resolveRemoteContext, isMethodAllowed } from "./remote-policy.js";

const MAX_CLIENTS = 64;

interface SocketState {
  peerId: string | null;
  generation: string;
  helloChallenge: string;
  helloExpiresAt: number;
  inflight: Set<string>;
  lastActivity: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export class SignedWssEndpoint {
  private service: AbmindService;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private nonceStore: NonceStore | null;
  private audit: RemoteAudit | null;
  private enrollments: RemoteEnrollmentV1[] = [];
  private grants: RemoteGrantV1[] = [];
  private config: RemoteEndpointConfig;
  private started = false;
  private clients = new Set<WebSocket>();
  /** #1701: quiesce/final-stop phases and accepted-dispatch visibility. */
  private quiesced = false;
  private acceptedDispatches = 0;
  /** #1701: response frames queued in ws but not yet flushed to their socket. */
  private pendingWrites = 0;

  constructor(service: AbmindService, nonceStore?: NonceStore, audit?: RemoteAudit) {
    this.service = service;
    this.nonceStore = nonceStore ?? null;
    this.audit = audit ?? null;
    this.config = loadEndpointConfig();
    this.enrollments = loadEnrollments();
    this.grants = loadGrants(this.enrollments);
  }

  get isStarted(): boolean { return this.started; }

  refreshConfig(): void {
    this.config = loadEndpointConfig();
    this.enrollments = loadEnrollments();
    this.grants = loadGrants(this.enrollments);
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!this.config.enabled) return;

    this.refreshConfig();
    this.nonceStore ??= new NonceStore();
    this.audit ??= new RemoteAudit();

    const tlsOpts = {
      key: readFileSync(this.config.tlsKeyPath, "utf-8"),
      cert: readFileSync(this.config.tlsCertPath, "utf-8"),
      minVersion: "TLSv1.3" as const,
    };

    this.server = createServer(tlsOpts);
    this.wss = new WebSocketServer({
      server: this.server,
      maxPayload: WSS_MAX_RAW_FRAME_BYTES,
    });
    this.wss.on("connection", (socket) => {
      if (this.clients.size >= MAX_CLIENTS) {
        socket.close(1013, "Too many clients");
        return;
      }
      this.clients.add(socket);
      socket.once("close", () => this.clients.delete(socket));
      this.handleConnection(socket);
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        this.started = true;
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  /**
   * #1701 phase boundary: idempotently stop accepting new TLS/WebSocket
   * connections without dropping established clients that own accepted
   * service work. Protocol, auth, and grants are untouched.
   */
  quiesce(): void {
    if (this.quiesced) return;
    this.quiesced = true;
    try { this.wss?.close(); } catch { /* best effort */ }
    try { this.server?.close(); } catch { /* best effort */ }
  }

  /**
   * #1701 final teardown: waits only the supplied remaining time for already
   * accepted dispatches to deliver their responses, then closes clients with
   * code 1001, clears timers, and closes nonce resources. Never introduces a
   * second unbounded wait.
   */
  async stop(timeoutMs = 5_000): Promise<{ drained: boolean; remainingRequests: number }> {
    this.started = false;
    this.quiesce();

    const deadline = Date.now() + Math.max(0, timeoutMs);
    while ((this.acceptedDispatches > 0 || this.pendingWrites > 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const drained = this.acceptedDispatches === 0 && this.pendingWrites === 0;
    const remainingRequests = this.acceptedDispatches;

    this.wss?.clients.forEach((c) => {
      const state = (c as any)._state as SocketState | undefined;
      if (state?.idleTimer) clearTimeout(state.idleTimer);
      state?.inflight.clear();
      try { c.close(1001, "Server shutdown"); } catch { /* best effort */ }
    });
    this.clients.clear();
    // No counter reset here: still-running dispatches decrement after the
    // timed-out wait returns, and the wait loop plus client closes above
    // already define the terminal state.
    try { this.wss?.close(); } catch { /* best effort */ }
    this.wss = null;
    try { this.server?.close(() => {}); } catch { /* best effort */ }
    this.server = null;
    this.nonceStore?.close();
    this.nonceStore = null;
    return { drained, remainingRequests };
  }

  private touchActivity(state: SocketState): void {
    state.lastActivity = Date.now();
  }

  private scheduleIdleCheck(state: SocketState, socket: WebSocket): void {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null;
      if (Date.now() - state.lastActivity > WSS_IDLE_TIMEOUT_MS) {
        socket.close(4001, "Idle timeout");
      }
    }, WSS_IDLE_TIMEOUT_MS);
  }

  private handleConnection(socket: WebSocket): void {
    const state: SocketState = {
      peerId: null,
      generation: randomUUID().slice(0, 12),
      helloChallenge: randomBytes(WSS_HELLO_CHALLENGE_BYTES).toString("hex"),
      helloExpiresAt: Date.now() + WSS_HELLO_EXPIRY_MS,
      inflight: new Set(),
      lastActivity: Date.now(),
      idleTimer: null,
    };
    (socket as any)._state = state;
    this.touchActivity(state);

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
      this.touchActivity(state);
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
      if (state.idleTimer) clearTimeout(state.idleTimer);
    });

    socket.on("error", () => {});
  }

  private handleHello(socket: WebSocket, state: SocketState, msg: unknown): void {
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      socket.close(4002, "Auth failed");
      return;
    }
    const hello = msg as Record<string, unknown>;
    if (hello.type !== "hello" || hello.version !== 1) {
      socket.close(4002, "Auth failed");
      return;
    }

    const peerId = String(hello.peerId ?? "");
    const connectionId = String(hello.connectionId ?? "");
    const challenge = String(hello.challenge ?? "");
    const timestamp = String(hello.timestamp ?? "");
    const signature = String(hello.signature ?? "");

    if (connectionId !== state.generation || challenge !== state.helloChallenge) {
      socket.close(4002, "Auth failed");
      return;
    }
    if (Date.now() > state.helloExpiresAt) {
      socket.close(4001, "Auth failed");
      return;
    }

    const enrollment = this.enrollments.find(e => e.peerId === peerId);
    if (!enrollment) {
      socket.close(4003, "Auth failed");
      return;
    }

    const result = verifyHello(peerId, connectionId, challenge, timestamp, signature, enrollment.verifyKey);
    if (!result.ok) {
      socket.close(4003, "Auth failed");
      return;
    }

    state.peerId = peerId;
    this.scheduleIdleCheck(state, socket);
    const ack = JSON.stringify({ type: "hello_ack", version: 1, peerId });
    socket.send(ack);
  }

  private async handleRequest(socket: WebSocket, state: SocketState, msg: unknown): Promise<void> {
    // A frame can arrive while final-stop client closes are still settling.
    // Once stopped, never touch torn-down resources (nonce store, audit).
    if (this.quiesced && this.nonceStore === null) return;
    // Host shutdown closes service admission before endpoint quiesce. Keep
    // established sockets available long enough to return the normal
    // unavailable response, but do not authenticate, audit, claim a nonce,
    // or count a late frame as accepted service work.
    if (this.service.isClosed) {
      const candidateId = typeof msg === "object" && msg !== null && !Array.isArray(msg)
        ? (msg as Record<string, unknown>).id
        : undefined;
      const frameId = typeof candidateId === "string" ? candidateId : "";
      this.sendError(socket, frameId, frameId, "unavailable", "Service is closed");
      return;
    }
    this.scheduleIdleCheck(state, socket);

    if (state.inflight.size >= WSS_MAX_INFLIGHT) {
      this.sendError(socket, "", "", "too_many_requests", "Max inflight reached");
      return;
    }

    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      this.sendError(socket, "", "", "invalid_frame", "Bad request");
      return;
    }
    const frame = msg as Record<string, unknown>;
    if (frame.type !== "request" || frame.version !== 1 || frame.method !== "abmind.request.v1") {
      this.sendError(socket, String(frame.id ?? ""), String(frame.id ?? ""), "invalid_frame", "Bad request");
      return;
    }

    if (typeof frame.id !== "string" || frame.id.length === 0 || frame.id.length > WSS_FRAME_ID_MAX) {
      this.sendError(socket, "", "", "invalid_frame", "Invalid request ID");
      return;
    }
    if (typeof frame.body !== "string") {
      this.sendError(socket, frame.id, frame.id, "invalid_frame", "Body must be a string");
      return;
    }
    const body = frame.body;
    if (Buffer.byteLength(body, "utf-8") > WSS_MAX_BODY_BYTES) {
      this.sendError(socket, frame.id, frame.id, "body_too_large", "Body exceeds max size");
      return;
    }

    const auth = frame.auth as Record<string, unknown> | undefined;
    if (!auth || typeof auth.peerId !== "string" || typeof auth.ts !== "string"
      || typeof auth.nonce !== "string" || typeof auth.sig !== "string"
      || !auth.peerId || !auth.ts || !auth.nonce || !auth.sig) {
      this.sendError(socket, frame.id, frame.id, "missing_auth", "Missing auth fields");
      return;
    }

    if (auth.peerId !== state.peerId) {
      this.sendError(socket, frame.id, frame.id, "auth_mismatch", "Peer ID mismatch");
      return;
    }

    const grant = this.grants.find(g => g.peerId === state.peerId);
    if (!grant) {
      this.sendError(socket, frame.id, frame.id, "no_grant", "Not authorized");
      return;
    }

    const sigResult = verifyRequestSignature(
      { peerId: auth.peerId, ts: auth.ts, nonce: auth.nonce, sig: auth.sig },
      frame.id,
      body,
      this.enrollments.find(e => e.peerId === state.peerId!)?.verifyKey ?? "",
    );
    if (!sigResult.ok) {
      this.sendError(socket, frame.id, frame.id, "auth_failed", "Request auth failed");
      return;
    }

    const claimResult = this.nonceStore!.claim(auth.peerId, auth.nonce);
    if (!claimResult.ok) {
      this.sendError(socket, frame.id, frame.id, "nonce_rejected", "Nonce rejected");
      return;
    }

    let innerReq: AbmindRequestV1;
    try {
      innerReq = JSON.parse(body);
    } catch {
      this.sendError(socket, frame.id, frame.id, "invalid_body", "Body not valid JSON");
      return;
    }

    if (typeof innerReq !== "object" || innerReq === null || Array.isArray(innerReq)
      || innerReq.version !== 1) {
      this.sendError(socket, frame.id, frame.id, "invalid_body", "Invalid inner request");
      return;
    }
    if (typeof innerReq.requestId !== "string"
      || innerReq.requestId.length === 0 || innerReq.requestId.length > REQUEST_ID_MAX) {
      this.sendError(socket, frame.id, frame.id, "invalid_body", "Invalid request ID");
      return;
    }
    if (typeof innerReq.method !== "string" || !(innerReq.method in METHOD_REGISTRY)) {
      this.sendError(socket, frame.id, innerReq.requestId, "unsupported_method", "Unknown method");
      return;
    }

    const context = resolveRemoteContext(grant, "signed_peer");
    if (!isMethodAllowed(innerReq.method as AbmindMethod, context)) {
      this.audit!.record(this.audit!.makeDecisionRecord(
        state.peerId!, grant.principalId, innerReq.requestId, innerReq.method, false, body.length,
      ));
      this.sendError(socket, frame.id, innerReq.requestId, "unauthorized", "Method not allowed");
      return;
    }

    if (state.inflight.has(innerReq.requestId)) {
      this.sendError(socket, frame.id, innerReq.requestId, "duplicate_request", "Request already in flight");
      return;
    }
    state.inflight.add(innerReq.requestId);
    const decisionRec = this.audit!.makeDecisionRecord(
      state.peerId!, grant.principalId, innerReq.requestId, innerReq.method, true, body.length,
    );
    if (!this.audit!.record(decisionRec)) {
      this.sendError(socket, frame.id, innerReq.requestId, "audit_failure", "Audit record failed");
      state.inflight.delete(innerReq.requestId);
      return;
    }

    const startMs = Date.now();
    this.acceptedDispatches++;
    try {
      const response = await this.service.handle(innerReq as AbmindRequestV1<AbmindMethod>, context);

      const respBody = JSON.stringify(response);
      if (Buffer.byteLength(respBody, "utf-8") > RESPONSE_MAX_BYTES) {
        this.sendError(socket, frame.id, innerReq.requestId, "response_too_large", "Response exceeds max size");
        return;
      }

      const outFrame: AbmindResponseFrameV1 = {
        type: "response", version: 1,
        id: frame.id,
        body: respBody,
      };
      this.sendFrame(socket, JSON.stringify(outFrame));

      this.audit!.record(this.audit!.makeOutcomeRecord(
        decisionRec.auditId, state.peerId!, grant.principalId,
        innerReq.requestId, innerReq.method,
        response.ok ? "ok" : response.error.code,
        Date.now() - startMs, body.length, respBody.length,
      ));
    } catch (err) {
      this.sendError(socket, frame.id, innerReq.requestId, "internal_error", "Internal error");
    } finally {
      state.inflight.delete(innerReq.requestId);
      this.acceptedDispatches--;
    }
  }

  /**
   * Send an error response. `outerId` is the outer frame ID used for transport
   * routing; `bodyRequestId` is the inner request ID written inside the body.
   * For failures before an inner request ID can be trusted, `bodyRequestId`
   * equals the outer frame ID — an explicit frame-level error marker, not a
   * claimed inner correlation.
   */
  private sendError(socket: WebSocket, outerId: string, bodyRequestId: string, code: string, message: string): void {
    const body = JSON.stringify({ ok: false, requestId: bodyRequestId, error: { code, message } });
    const resp: AbmindResponseFrameV1 = { type: "response", version: 1, id: outerId, body };
    this.sendFrame(socket, JSON.stringify(resp));
  }

  private sendFrame(socket: WebSocket, json: string): void {
    let counted = false;
    try {
      if (Buffer.byteLength(json, "utf-8") + socket.bufferedAmount > WSS_MAX_QUEUED_WRITE_BYTES) return;
      this.pendingWrites++;
      counted = true;
      let settled = false;
      const settledCallback = (): void => {
        if (settled) return;
        settled = true;
        this.pendingWrites--;
      };
      socket.send(json, settledCallback);
    } catch {
      // `send()` may throw synchronously when a client closes between the
      // ready-state check and the write. Do not leave shutdown waiting on a
      // write that was never queued.
      if (counted) this.pendingWrites--;
    }
  }
}
