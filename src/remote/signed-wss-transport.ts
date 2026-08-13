import { readFileSync } from "node:fs";
import WebSocket from "ws";
import type { AbmindMethod, AbmindRequestV1, AbmindResponseV1, AbmindCapabilitiesV1, AbmindTransport } from "../abmind-protocol.js";
import { ABMIND_PROTOCOL_VERSION, errorBodyV1 } from "../abmind-protocol.js";
import {
  WSS_REQUEST_TIMEOUT_MS,
  type AbmindResponseFrameV1, type WssAuthFields,
} from "./signed-wire.js";
import { signRequest, signHello as edSignHello, verifyCertificatePin } from "./signed-auth.js";
import { RequestOutbox, OUTBOX_MAX_ATTEMPTS } from "./request-outbox.js";
import { RouteController } from "./route-controller.js";
import type { RetryFailureClass, AbmindRouteSnapshotV1 } from "./route-contract.js";
import type { RemoteClientProfileV1 } from "./remote-config.js";

interface PendingRequest {
  resolve: ((value: AbmindResponseV1) => void) | null;
  timer: ReturnType<typeof setTimeout>;
  requestId: string;
}

export interface SignedWssTransportOptions {
  /** Injected clock (epoch ms) for deterministic tests. */
  now?: () => number;
  /** Injected random (0..1) for backoff jitter in deterministic tests. */
  random?: () => number;
  /** Per-attempt response timeout. */
  requestTimeoutMs?: number;
  /** Overall persisted retry deadline from admission. */
  retryDeadlineMs?: number;
  /** Retry backoff base delay. */
  retryBaseMs?: number;
  /** Retry backoff maximum delay. */
  retryMaxMs?: number;
  /** Maximum jitter on retry backoff. */
  retryJitterMs?: number;
  /** Maximum send attempts per admitted entry. */
  retryMaxAttempts?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  reconnectMaxAttempts?: number;
}

function retryDelay(opts: SignedWssTransportOptions, attempts: number, rng: () => number): number {
  const base = opts.retryBaseMs ?? 1_000;
  const max = opts.retryMaxMs ?? 60_000;
  const jitter = opts.retryJitterMs ?? 250;
  const raw = Math.min(base * Math.pow(2, attempts - 1), max);
  const jittered = raw + Math.floor(rng() * (jitter + 1));
  return Math.min(jittered, max + 1000);
}

export class SignedWssTransport implements AbmindTransport {
  private profile: RemoteClientProfileV1;
  private signingKey: string;
  private outbox: RequestOutbox;
  private controller: RouteController;
  private pending = new Map<string, PendingRequest>();
  /** Frame ID → socket generation the frame was last sent on. */
  private sentOnGen = new Map<string, number>();
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private closed_ = false;
  private degraded_ = false;
  private opts: Required<Pick<SignedWssTransportOptions,
    "requestTimeoutMs" | "retryDeadlineMs" | "retryMaxAttempts">> & SignedWssTransportOptions;
  private rng: () => number;

  constructor(profile: RemoteClientProfileV1, outbox?: RequestOutbox, options: SignedWssTransportOptions = {}) {
    this.profile = profile;
    this.signingKey = readFileSync(profile.signingKeyPath, "utf-8");
    this.outbox = outbox ?? new RequestOutbox(profile.peerId);
    this.opts = {
      requestTimeoutMs: options.requestTimeoutMs ?? WSS_REQUEST_TIMEOUT_MS,
      retryDeadlineMs: options.retryDeadlineMs ?? 15 * 60_000,
      retryMaxAttempts: options.retryMaxAttempts ?? OUTBOX_MAX_ATTEMPTS,
      ...options,
    };
    this.rng = options.random ?? Math.random;
    this.controller = new RouteController(
      profile.url,
      profile.peerId,
      {
        signFrame: (frameId, body) => this.signFrame(frameId, body),
        signHello: (connectionId, challenge, timestamp) => ({
          sig: edSignHello(this.profile.peerId, connectionId, challenge, timestamp, this.signingKey),
        }),
        verifyServerPin: (socket) => this.verifyServerPin(socket),
      },
      {
        onReady: () => this.schedulePump(),
        onRouteLost: () => this.handleRouteLost(),
        onMessage: (text, gen) => this.handleMessage(text, gen),
      },
      {
        now: options.now,
        random: options.random,
        reconnectBaseMs: options.reconnectBaseMs,
        reconnectMaxMs: options.reconnectMaxMs,
        reconnectMaxAttempts: options.reconnectMaxAttempts,
      },
    );
    if (this.outbox.isQuarantined) this.degraded_ = true;
  }

  get capabilities(): AbmindCapabilitiesV1 | null { return this.controller.capabilities; }

  /** Immutable bounded route snapshot for diagnostics. */
  get routeSnapshot(): AbmindRouteSnapshotV1 {
    return this.controller.snapshot(this.outbox.counts());
  }

  get isDegraded(): boolean { return this.degraded_ || this.outbox.isDegraded || this.outbox.isQuarantined; }

  async negotiate(): Promise<AbmindCapabilitiesV1> {
    if (this.degraded_ || this.outbox.isQuarantined) {
      throw new Error("Outbox state is not usable");
    }
    return this.controller.negotiate();
  }

  async request<K extends AbmindMethod>(req: AbmindRequestV1<K>): Promise<AbmindResponseV1<K>> {
    if (this.closed_) {
      return { ok: false, requestId: req.requestId, error: errorBodyV1("unavailable", "Transport is closed", "response") } as AbmindResponseV1<K>;
    }
    if (this.degraded_ || this.outbox.isQuarantined || this.outbox.isDegraded) {
      return { ok: false, requestId: req.requestId, error: errorBodyV1("unavailable", "Outbox state is not usable", "pre_dispatch") } as AbmindResponseV1<K>;
    }
    // Fail-closed admission: only a ready current generation admits work.
    if (!this.controller.isReady()) {
      return { ok: false, requestId: req.requestId, error: errorBodyV1("unavailable", "Route not ready", "pre_dispatch") } as AbmindResponseV1<K>;
    }

    const requestId = req.requestId ?? `wss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body = JSON.stringify({ version: ABMIND_PROTOCOL_VERSION, requestId, method: req.method, idempotencyKey: req.idempotencyKey, payload: req.payload });
    const frameId = `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const appended = this.outbox.append(frameId, req.method, requestId, req.idempotencyKey, body, ABMIND_PROTOCOL_VERSION, req.payload);
    if (!appended) {
      return { ok: false, requestId, error: errorBodyV1("unavailable", "Outbox persistence failed", "pre_dispatch") };
    }

    return new Promise<AbmindResponseV1<K>>((resolve) => {
      this.pending.set(frameId, { resolve: resolve as (v: AbmindResponseV1) => void, timer: 0 as unknown as ReturnType<typeof setTimeout>, requestId });
      this.sendEntry(frameId);
    });
  }

  async close(): Promise<void> {
    this.closed_ = true;
    if (this.pumpTimer) { clearTimeout(this.pumpTimer); this.pumpTimer = null; }
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      if (p.resolve) {
        p.resolve({ ok: false, requestId: p.requestId, error: errorBodyV1("unavailable", "Transport closed", "response") });
      }
    }
    this.pending.clear();
    this.sentOnGen.clear();
    this.controller.close();
  }

  // ── Delivery ─────────────────────────────────────────────────────────────

  private sendEntry(frameId: string): void {
    const entry = this.outbox.get(frameId);
    if (!entry) return;
    if (!this.controller.isReady()) return; // onReady pumps when the route returns
    if (this.sentOnGen.size > 0) return; // one in-flight send; completion paths pump

    const now = this.opts.now?.() ?? Date.now();
    if (this.outbox.isExhausted(entry, now)) {
      this.settleTerminalUnknown(frameId, "timeout");
      return;
    }
    if (!this.outbox.markInFlight(frameId)) {
      if (this.outbox.isDegraded) { this.markDegraded(); return; }
      return;
    }

    const auth = this.signFrame(frameId, entry.body);
    const frame = {
      type: "request", version: 1, id: frameId, method: "abmind.request.v1", body: entry.body, auth,
    } as const;
    this.sentOnGen.set(frameId, this.controller.generation);

    const pending = this.pending.get(frameId);
    clearTimeout(pending?.timer);
    const timer = setTimeout(() => {
      const current = this.outbox.get(frameId);
      if (current && current.state === "in_flight") {
        this.recordUncertainFailure(frameId, "timeout");
      }
    }, this.opts.requestTimeoutMs);
    if (pending) pending.timer = timer;

    try {
      const sent = this.controller.send(JSON.stringify(frame));
      if (!sent) throw new Error("Send failed");
    } catch {
      this.recordUncertainFailure(frameId, "send_failed");
    }
  }

  private recordUncertainFailure(frameId: string, failure: RetryFailureClass): void {
    const entry = this.outbox.get(frameId);
    if (!entry || entry.state === "terminal_unknown") return;
    // The current send attempt is over: free the one-send gate and correlation.
    this.sentOnGen.delete(frameId);
    const now = this.opts.now?.() ?? Date.now();
    if (this.outbox.isExhausted(entry, now)) {
      this.settleTerminalUnknown(frameId, "timeout");
      return;
    }
    const delay = retryDelay(this.opts, entry.attempts + 1, this.rng);
    if (!this.outbox.markRetryWait(frameId, failure, now + delay)) {
      if (this.outbox.isDegraded) { this.markDegraded(); return; }
    }
    this.schedulePump();
  }

  private settleTerminalUnknown(frameId: string, failure: RetryFailureClass): void {
    const entry = this.outbox.get(frameId);
    const pending = this.pending.get(frameId);
    const requestId = entry?.requestId ?? pending?.requestId ?? frameId;
    const acked = this.outbox.markTerminalUnknown(frameId, failure);
    if (!acked && this.outbox.isDegraded) { this.markDegraded(); return; }
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(frameId);
      if (pending.resolve) {
        pending.resolve({ ok: false, requestId, error: errorBodyV1("outcome_unknown", "Request outcome unknown after retry budget", "response") });
      }
    }
    this.sentOnGen.delete(frameId);
    this.schedulePump();
  }

  private handleRouteLost(): void {
    const now = this.opts.now?.() ?? Date.now();
    for (const [frameId] of this.sentOnGen) {
      const entry = this.outbox.get(frameId);
      if (entry && entry.state === "in_flight") {
        if (this.outbox.isExhausted(entry, now)) {
          this.settleTerminalUnknown(frameId, "socket_lost");
          continue;
        }
        const delay = retryDelay(this.opts, entry.attempts + 1, this.rng);
        if (!this.outbox.markRetryWait(frameId, "socket_lost", now + delay)) {
          if (this.outbox.isDegraded) { this.markDegraded(); return; }
        }
      }
    }
    this.sentOnGen.clear();
  }

  private markDegraded(): void {
    this.degraded_ = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      if (p.resolve) {
        p.resolve({ ok: false, requestId: p.requestId, error: errorBodyV1("unavailable", "Outbox persistence failed", "pre_dispatch") });
      }
    }
    this.pending.clear();
    this.sentOnGen.clear();
    this.controller.close();
  }

  private schedulePump(): void {
    if (this.closed_ || this.degraded_ || !this.controller.isReady()) return;
    if (this.pumpTimer) return;
    const now = this.opts.now?.() ?? Date.now();
    const due = this.outbox.peekDue(now);
    if (!due) {
      // Nothing due now: arm one bounded timer for the earliest next attempt.
      const next = this.outbox.counts().nextAttemptAt;
      if (next !== undefined && next > now) {
        this.pumpTimer = setTimeout(() => {
          this.pumpTimer = null;
          this.schedulePump();
        }, Math.min(next - now, this.opts.requestTimeoutMs));
      }
      return;
    }
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      if (this.closed_ || this.degraded_ || !this.controller.isReady()) return;
      const pumpNow = this.opts.now?.() ?? Date.now();
      const nextDue = this.outbox.peekDue(pumpNow);
      if (nextDue) this.sendEntry(nextDue.id);
    }, 0);
  }

  // ── Response handling ────────────────────────────────────────────────────

  private handleMessage(text: string, gen: number): void {
    let msg: AbmindResponseFrameV1;
    try {
      msg = JSON.parse(text) as AbmindResponseFrameV1;
    } catch {
      return;
    }
    if (msg.type !== "response" || msg.version !== 1) return;

    // Correlation: only frames we sent on this exact socket generation count.
    const sentGen = this.sentOnGen.get(msg.id);
    if (sentGen === undefined || sentGen !== gen) return;

    let response: AbmindResponseV1;
    try {
      response = JSON.parse(msg.body) as AbmindResponseV1;
    } catch {
      return; // malformed response cannot settle or acknowledge
    }

    const pending = this.pending.get(msg.id);
    if (pending) {
      const frameLevelError = !response.ok && response.requestId === msg.id;
      if (!frameLevelError && response.requestId !== pending.requestId) {
        // Wrong inner request ID: ambiguous, never settles a caller.
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      this.sentOnGen.delete(msg.id);
      const acked = this.outbox.acknowledge(msg.id);
      if (!acked) {
        this.markDegraded();
        return;
      }
      if (pending.resolve) {
        pending.resolve(frameLevelError
          ? { ...response, requestId: pending.requestId }
          : response);
      }
      this.schedulePump();
      return;
    }

    // No live caller: idempotent replay of a pump-only send. Acknowledge only
    // a terminal response that matches the durable entry exactly.
    const replay = this.outbox.get(msg.id);
    if (!replay) return;
    const frameLevelError = !response.ok && response.requestId === msg.id;
    if (!frameLevelError && response.requestId !== replay.requestId) return;
    this.sentOnGen.delete(msg.id);
    if (!this.outbox.acknowledge(msg.id)) {
      this.markDegraded();
    }
    this.schedulePump();
  }

  // ── Route controller glue ────────────────────────────────────────────────

  private signFrame(frameId: string, body: string): WssAuthFields {
    return signRequest(this.profile.peerId, frameId, body, this.signingKey);
  }

  private verifyServerPin(socket: WebSocket): boolean {
    try {
      const cert = (socket as any)._socket?.getPeerCertificate();
      if (!cert || !cert.raw) return false;
      verifyCertificatePin(cert.raw, this.profile.serverCertSha256);
      return true;
    } catch {
      return false;
    }
  }
}
