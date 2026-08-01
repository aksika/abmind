import WebSocket from "ws";
import {
  WSS_HANDSHAKE_TIMEOUT_MS,
  type AbmindResponseFrameV1, type WssAuthFields,
} from "./signed-wire.js";
import type {
  AbmindCapabilitiesV1,
} from "../abmind-protocol.js";
import { ABMIND_PROTOCOL_VERSION } from "../abmind-protocol.js";
import type {
  AbmindRouteReasonCode, AbmindRouteSnapshotV1, AbmindRouteState,
} from "./route-contract.js";

/** Reconnect bounds (identical values to the legacy WSS_RECONNECT_* constants). */
export const ROUTE_RECONNECT_BASE_MS_DEFAULT = 1_000;
export const ROUTE_RECONNECT_MAX_MS_DEFAULT = 60_000;
export const ROUTE_RECONNECT_MAX_ATTEMPTS_DEFAULT = 10;

export interface RouteControllerOptions {
  /** Injected clock (epoch ms) for deterministic tests. */
  now?: () => number;
  /** Injected random (0..1) for jitter in deterministic tests. */
  random?: () => number;
  /** Reconnect delay for the given attempt (1-based). */
  connectDelay?: (attempt: number) => number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  reconnectMaxAttempts?: number;
}

export interface RouteControllerSigning {
  signFrame(frameId: string, body: string): WssAuthFields;
  signHello(connectionId: string, challenge: string, timestamp: string): { sig: string };
  verifyServerPin(socket: WebSocket): boolean;
}

export interface RouteControllerCallbacks {
  /** A fully authenticated and renegotiated generation is ready to admit work. */
  onReady(generation: number): void;
  /** A previously ready route was lost; capabilities are already cleared. */
  onRouteLost(generation: number): void;
  /** A framed message arrived on the current socket generation. */
  onMessage(text: string, generation: number): void;
}

interface PendingControl {
  resolve: (caps: AbmindCapabilitiesV1) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  id: string;
  requestId: string;
}

/**
 * Generation-bound route state machine for one signed-WSS client.
 *
 * Owns the socket, TLS/pin verification, signed authentication, and the
 * `system.negotiate` control exchange. Capabilities are bound to one socket
 * generation and cleared before route loss is published. Domain-request
 * admission is never inferred from `socket.readyState`; the only admission
 * predicate is `isReady()`.
 */
export class RouteController {
  private profileUrl: string;
  private peerId: string;
  private signing: RouteControllerSigning;
  private callbacks: RouteControllerCallbacks;
  private opts: RouteControllerOptions;

  private state_: AbmindRouteState = "disconnected";
  private generation_ = 0;
  private negotiatedGeneration = -1;
  private reasonCode_: AbmindRouteReasonCode | undefined;
  private capabilities_: AbmindCapabilitiesV1 | null = null;
  private socket: WebSocket | null = null;
  private connectingSocket: WebSocket | null = null;
  private establishing: Promise<AbmindCapabilitiesV1> | null = null;
  private activeEstablishment: { gen: number; fail: (err: Error) => void } | null = null;
  private pendingControl: PendingControl | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed_ = false;

  constructor(
    profileUrl: string,
    peerId: string,
    signing: RouteControllerSigning,
    callbacks: RouteControllerCallbacks,
    opts: RouteControllerOptions = {},
  ) {
    this.profileUrl = profileUrl;
    this.peerId = peerId;
    this.signing = signing;
    this.callbacks = callbacks;
    this.opts = opts;
  }

  get state(): AbmindRouteState { return this.state_; }
  get generation(): number { return this.generation_; }
  get reasonCode(): AbmindRouteReasonCode | undefined { return this.reasonCode_; }
  get capabilities(): AbmindCapabilitiesV1 | null { return this.capabilities_; }

  /** Admission predicate: a ready, current, negotiated generation with capabilities. */
  isReady(): boolean {
    return this.state_ === "ready"
      && this.generation_ === this.negotiatedGeneration
      && this.capabilities_ !== null
      && this.socket !== null
      && this.socket.readyState === WebSocket.OPEN;
  }

  /**
   * Establish or rearm the route. Coalesces concurrent calls onto one bounded
   * attempt. When already ready, returns the bound capabilities.
   */
  negotiate(): Promise<AbmindCapabilitiesV1> {
    if (this.closed_) {
      return Promise.reject(new Error("Transport is closed"));
    }
    if (this.state_ === "ready" && this.capabilities_ && this.generation_ === this.negotiatedGeneration) {
      return Promise.resolve(this.capabilities_);
    }
    if (this.establishing) return this.establishing;

    // Rearm: cancel any pending reconnect timer so exactly one attempt runs.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.state_ === "unavailable") {
      this.reasonCode_ = undefined;
      this.state_ = "disconnected";
    }
    const attempt = this.establish();
    this.establishing = attempt;
    void attempt.then(
      () => { if (this.establishing === attempt) this.establishing = null; },
      () => { if (this.establishing === attempt) this.establishing = null; },
    );
    return attempt;
  }

  snapshot(counts: { retryEligible: number; terminalUnknown: number; nextAttemptAt?: number }): AbmindRouteSnapshotV1 {
    const snap: AbmindRouteSnapshotV1 = {
      version: 1,
      state: this.state_,
      generation: this.generation_,
      retryEligible: counts.retryEligible,
      terminalUnknown: counts.terminalUnknown,
    };
    if (this.reasonCode_) snap.reasonCode = this.reasonCode_;
    if (counts.nextAttemptAt !== undefined) snap.nextAttemptAt = counts.nextAttemptAt;
    return snap;
  }

  /**
   * Send a raw framed text message through the current ready socket.
   * Returns false when no ready generation exists or the send throws.
   */
  send(text: string): boolean {
    if (!this.isReady() || !this.socket) return false;
    try {
      this.socket.send(text);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    const closingGeneration = this.generation_;
    this.closed_ = true;
    this.state_ = "closed";
    this.reasonCode_ = "transport_closed";
    this.generation_++;
    this.capabilities_ = null;
    this.negotiatedGeneration = -1;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pendingControl) {
      clearTimeout(this.pendingControl.timer);
      this.pendingControl.reject(new Error("Transport closed"));
      this.pendingControl = null;
    }
    if (this.activeEstablishment?.gen === closingGeneration) {
      const active = this.activeEstablishment;
      this.activeEstablishment = null;
      active.fail(new Error("Transport closed"));
    }
    if (this.connectingSocket) {
      try { this.connectingSocket.terminate(); } catch { /* best effort */ }
      this.connectingSocket = null;
    }
    if (this.socket) {
      try { this.socket.close(); } catch { /* best effort */ }
      this.socket = null;
    }
  }

  // ── Establishment ────────────────────────────────────────────────────────

  private establish(): Promise<AbmindCapabilitiesV1> {
    const gen = ++this.generation_;
    this.state_ = "connecting";
    this.reasonCode_ = undefined;

    return new Promise<AbmindCapabilitiesV1>((resolve, reject) => {
      const socket = new WebSocket(this.profileUrl, {
        rejectUnauthorized: false,
        handshakeTimeout: WSS_HANDSHAKE_TIMEOUT_MS,
      });
      let connected = false;
      let established = false;
      let settled = false;
      this.connectingSocket = socket;

      const fail = (err: Error, reason: AbmindRouteReasonCode, transient: boolean): void => {
        if (settled) return;
        settled = true;
        if (this.activeEstablishment?.gen === gen) this.activeEstablishment = null;
        this.detachSocket(socket, gen);
        if (this.closed_ || gen !== this.generation_) {
          reject(new Error("Transport closed"));
          return;
        }
        if (transient) {
          this.state_ = "reconnecting";
          this.reasonCode_ = reason;
          this.scheduleReconnect();
          reject(err);
        } else {
          this.state_ = "unavailable";
          this.reasonCode_ = reason;
          this.capabilities_ = null;
          this.negotiatedGeneration = -1;
          reject(err);
        }
      };
      this.activeEstablishment = { gen, fail: (err) => fail(err, "transport_closed", true) };

      socket.on("open", () => {
        if (settled || this.closed_ || gen !== this.generation_) {
          socket.close();
          return;
        }
        if (!this.signing.verifyServerPin(socket)) {
          socket.close(4003, "Certificate pin mismatch");
          fail(new Error("Server certificate pin mismatch"), "pin_mismatch", false);
          return;
        }
        if (this.socket && this.socket !== socket) {
          try { this.socket.close(); } catch { /* best effort */ }
        }
        this.socket = socket;
        if (this.connectingSocket === socket) this.connectingSocket = null;
        connected = true;
        this.state_ = "authenticating";
        this.authenticate(socket, gen).then(() => {
          if (settled || this.closed_ || gen !== this.generation_) return;
          this.state_ = "negotiating";
          this.runControlNegotiate(socket, gen).then((caps) => {
            if (settled || this.closed_ || gen !== this.generation_) return;
            settled = true;
            established = true;
            if (this.activeEstablishment?.gen === gen) this.activeEstablishment = null;
            this.capabilities_ = caps;
            this.negotiatedGeneration = gen;
            this.reconnectAttempts = 0;
            this.state_ = "ready";
            this.reasonCode_ = undefined;
            resolve(caps);
            this.callbacks.onReady(gen);
          }).catch((err: Error) => {
            fail(err, "negotiation_failed", false);
          });
        }).catch((err: Error) => {
          fail(err, "authentication_failed", false);
        });
      });

      socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
        if (gen !== this.generation_ || this.closed_) return;
        if (this.pendingControl) {
          const data: Buffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as never);
          this.handleControlMessage(data.toString("utf-8"));
          return;
        }
        const data: Buffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as never);
        this.callbacks.onMessage(data.toString("utf-8"), gen);
      });

      socket.on("close", () => {
        if (this.closed_) {
          // close() during establishment must settle the negotiate promise.
          if (!settled) { settled = true; reject(new Error("Transport closed")); }
          return;
        }
        if (gen !== this.generation_) return;
        if (connected || established) {
          // A ready route (or an opened handshake socket) was lost: clear
          // capabilities immediately, then retry under the bounded policy.
          this.loseRoute(gen);
          return;
        }
        if (settled) return;
        this.state_ = "reconnecting";
        this.reasonCode_ = "connection_failed";
        this.scheduleReconnect();
        settled = true;
        reject(new Error("Connection closed before open"));
      });

      socket.on("error", (err) => {
        if (this.closed_) {
          if (!settled) { settled = true; reject(new Error("Transport closed")); }
          return;
        }
        if (gen !== this.generation_) return;
        if (!connected) {
          fail(err instanceof Error ? err : new Error(String(err)), "connection_failed", true);
        }
      });
    });
  }

  /** Clear capabilities and publish route loss for the current generation. */
  private loseRoute(gen: number): void {
    if (this.closed_ || gen !== this.generation_) return;
    this.capabilities_ = null;
    this.negotiatedGeneration = -1;
    const lostControl = this.pendingControl;
    this.pendingControl = null;
    if (lostControl) {
      clearTimeout(lostControl.timer);
      lostControl.reject(new Error("Route lost"));
    }
    // Invalidate the lost generation before any old promise or socket event
    // can run. This keeps late messages from settling a new generation's
    // control exchange or domain request.
    this.generation_++;
    if (this.activeEstablishment?.gen === gen) {
      const active = this.activeEstablishment;
      this.activeEstablishment = null;
      active.fail(new Error("Route lost"));
    }
    this.state_ = "reconnecting";
    this.reasonCode_ = "transport_closed";
    this.socket = null;
    this.callbacks.onRouteLost(gen);
    this.scheduleReconnect();
  }

  private detachSocket(socket: WebSocket, gen: number): void {
    if (this.socket === socket) this.socket = null;
    if (this.connectingSocket === socket) this.connectingSocket = null;
    if (this.pendingControl && gen === this.generation_) {
      clearTimeout(this.pendingControl.timer);
      this.pendingControl = null;
    }
    try { socket.close(); } catch { /* best effort */ }
  }

  private scheduleReconnect(): void {
    if (this.closed_ || this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.reconnectMaxAttempts()) {
      this.state_ = "unavailable";
      this.reasonCode_ = "retry_exhausted";
      return;
    }
    this.reconnectAttempts++;
    const delay = this.opts.connectDelay
      ? this.opts.connectDelay(this.reconnectAttempts)
      : this.backoffDelay(this.reconnectAttempts);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed_) return;
      const attempt = this.establish();
      this.establishing = attempt;
      void attempt.then(
        () => { if (this.establishing === attempt) this.establishing = null; },
        () => { if (this.establishing === attempt) this.establishing = null; },
      );
    }, delay);
  }

  private backoffDelay(attempt: number): number {
    const base = this.opts.reconnectBaseMs ?? ROUTE_RECONNECT_BASE_MS_DEFAULT;
    const max = this.opts.reconnectMaxMs ?? ROUTE_RECONNECT_MAX_MS_DEFAULT;
    return Math.min(base * Math.pow(2, attempt - 1), max);
  }

  private reconnectMaxAttempts(): number {
    return this.opts.reconnectMaxAttempts ?? ROUTE_RECONNECT_MAX_ATTEMPTS_DEFAULT;
  }

  // ── Authentication and control negotiation ──────────────────────────────

  private authenticate(socket: WebSocket, gen: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      let timeout: ReturnType<typeof setTimeout>;
      let handler: (raw: Buffer | ArrayBuffer | Buffer[]) => void;
      let onClose: () => void;
      const cleanup = (): void => {
        clearTimeout(timeout);
        socket.removeListener("message", handler);
        socket.removeListener("close", onClose);
      };
      const rejectAuth = (err: Error): void => {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(err);
      };
      onClose = (): void => rejectAuth(new Error("Route lost"));
      timeout = setTimeout(() => rejectAuth(new Error("Auth timeout")), WSS_HANDSHAKE_TIMEOUT_MS);

      handler = (raw: Buffer | ArrayBuffer | Buffer[]) => {
        if (gen !== this.generation_ || this.closed_ || this.socket !== socket) return;
        const data: Buffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as never);
        let msg: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(data.toString("utf-8"));
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
          msg = parsed as Record<string, unknown>;
        } catch {
          return;
        }

        if (msg.type === "challenge" && msg.version === 1) {
          try {
            const connectionId = msg.connectionId as string;
            const challenge = msg.challenge as string;
            const timestamp = String(Math.floor((this.opts.now?.() ?? Date.now()) / 1000));
            const auth = this.signing.signHello(connectionId, challenge, timestamp);
            socket.send(JSON.stringify({
              type: "hello", version: 1,
              peerId: this.peerId,
              connectionId, challenge, timestamp,
              signature: auth.sig,
            }));
          } catch (err) {
            rejectAuth(err instanceof Error ? err : new Error(String(err)));
          }
        } else if (msg.type === "hello_ack") {
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve();
          }
        }
      };

      socket.on("message", handler);
      socket.once("close", onClose);
    });
  }

  /** Bounded correlated control exchange: system.negotiate through the socket. */
  private runControlNegotiate(socket: WebSocket, gen: number): Promise<AbmindCapabilitiesV1> {
    if (gen !== this.generation_ || this.closed_ || this.socket !== socket) {
      return Promise.reject(new Error("Route generation changed"));
    }
    const requestId = `ctrl-negotiate-${gen}-${Math.random().toString(36).slice(2, 8)}`;
    const frameId = `f-ctrl-${gen}-${Math.random().toString(36).slice(2, 8)}`;
    const body = JSON.stringify({
      version: ABMIND_PROTOCOL_VERSION,
      requestId,
      method: "system.negotiate",
      payload: {},
    });
    const auth = this.signing.signFrame(frameId, body);
    const frameJson = JSON.stringify({
      type: "request", version: 1, id: frameId, method: "abmind.request.v1", body, auth,
    });

    return new Promise<AbmindCapabilitiesV1>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingControl) this.pendingControl = null;
        reject(new Error("Negotiation timed out"));
      }, WSS_HANDSHAKE_TIMEOUT_MS);
      this.pendingControl = { resolve, reject, timer, id: frameId, requestId };

      try {
        socket.send(frameJson);
      } catch (err) {
        clearTimeout(timer);
        this.pendingControl = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private handleControlMessage(text: string): void {
    if (!this.pendingControl) return;
    let msg: AbmindResponseFrameV1;
    try {
      msg = JSON.parse(text) as AbmindResponseFrameV1;
    } catch {
      return;
    }
    if (msg.type !== "response" || msg.version !== 1 || msg.id !== this.pendingControl.id) return;
    const control = this.pendingControl;
    this.pendingControl = null;
    clearTimeout(control.timer);
    try {
      const response = JSON.parse(msg.body) as { ok: boolean; requestId: string; result?: unknown; error?: { code: string; message: string } };
      if (!response.ok || response.requestId !== control.requestId) {
        control.reject(new Error(`Negotiation failed: ${response.error?.code ?? "unknown"}`));
        return;
      }
      const caps = response.result;
      if (!isCapabilitiesV1(caps)) {
        control.reject(new Error("Negotiation failed: malformed capabilities"));
        return;
      }
      control.resolve(caps);
    } catch {
      control.reject(new Error("Negotiation failed: invalid response"));
    }
  }
}

function isCapabilitiesV1(value: unknown): value is AbmindCapabilitiesV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const caps = value as Record<string, unknown>;
  return typeof caps.version === "number"
    && Array.isArray(caps.methods) && caps.methods.every(m => typeof m === "string")
    && typeof caps.features === "object" && caps.features !== null && !Array.isArray(caps.features);
}
