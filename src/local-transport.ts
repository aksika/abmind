import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { createFrameAccumulator, encodeFrame, REQUEST_TIMEOUT_MS, RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS, RECONNECT_MAX_ATTEMPTS, type FrameAccumulator } from "./abmind-frame-codec.js";
import type { AbmindMethod, AbmindRequestV1, AbmindResponseV1, AbmindCapabilitiesV1, AbmindTransport, AbmindErrorBodyV1 } from "./abmind-protocol.js";
import { ABMIND_PROTOCOL_VERSION, errorBodyV1, isMutatingMethod } from "./abmind-protocol.js";
import { logWarn } from "./mem-logger.js";

const TAG = "local-transport";

/**
 * One socket connection with its own framing accumulator. Every data/close/
 * error callback captures the generation it was created for and may mutate
 * transport state only while that generation is current (#1659).
 */
type ConnectionGeneration = {
  readonly id: number;
  readonly socket: Socket;
  readonly accumulator: FrameAccumulator;
};

interface PendingRecord {
  resolve: (value: AbmindResponseV1) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  frame: Buffer;
  requestId: string;
  /** Mutation requests classify post-write uncertainty as outcome_unknown. */
  mutation: boolean;
  /** True when the request carried an idempotency key (exact-key replayable). */
  idempotent: boolean;
  /** Absolute deadline; never extended by reconnects. */
  deadline: number;
  /** Guards against double-settling from competing delivery paths. */
  settled: boolean;
}

/**
 * #1659: synthesize a failure body for a request whose transport outcome is
 * uncertain. Reads never mutate, so they stay retryable `unavailable`;
 * mutations may have been accepted, so they become non-retryable
 * `outcome_unknown` unless a definitive result is already known.
 */
function uncertainFailureBody(mutation: boolean, message: string): AbmindErrorBodyV1 {
  return errorBodyV1(
    mutation ? "outcome_unknown" : "unavailable",
    message,
    "response",
  );
}

export class LocalTransport implements AbmindTransport {
  private readonly socketPath: string;
  private currentGeneration: ConnectionGeneration | null = null;
  private generationSeq = 0;
  private pending = new Map<string, PendingRecord>();
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private reconnectAttempts = 0;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async negotiate(): Promise<AbmindCapabilitiesV1> {
    const response = await this.request({
      version: ABMIND_PROTOCOL_VERSION, requestId: "negotiate", method: "system.negotiate", payload: {},
    });
    if (response.ok) return response.result as AbmindCapabilitiesV1;
    throw new Error(`Negotiation failed: ${response.error.message}`);
  }

  async request<K extends AbmindMethod>(req: AbmindRequestV1<K>): Promise<AbmindResponseV1<K>> {
    const mutation = isMutatingMethod(req.method);
    if (this.closed) {
      return { ok: false, requestId: req.requestId, error: errorBodyV1("unavailable", "Transport is closed", "pre_dispatch") } as AbmindResponseV1<K>;
    }

    try {
      await this.ensureConnected();
    } catch {
      return { ok: false, requestId: req.requestId, error: errorBodyV1("unavailable", "Could not connect to daemon", "pre_dispatch") } as AbmindResponseV1<K>;
    }

    const requestId = req.requestId ?? randomUUID().slice(0, 8);
    const requestWithId = { ...req, requestId };

    // Capture the generation we intend to write on; a reconnect that replaces
    // the generation between connection and write must not use a stale socket.
    const gen = this.currentGeneration;
    if (!gen || gen.socket.destroyed) {
      return { ok: false, requestId, error: errorBodyV1("unavailable", "Connection lost before write", "pre_dispatch") } as AbmindResponseV1<K>;
    }

    return new Promise<AbmindResponseV1<K>>((resolve, reject) => {
      const deadline = Date.now() + REQUEST_TIMEOUT_MS;
      const pending: PendingRecord = {
        resolve: resolve as (value: AbmindResponseV1) => void,
        reject,
        timer: 0 as unknown as ReturnType<typeof setTimeout>,
        frame: Buffer.alloc(0),
        requestId,
        mutation,
        idempotent: req.idempotencyKey !== undefined,
        deadline,
        settled: false,
      };
      pending.timer = setTimeout(() => this.settleTimeout(pending, requestId), REQUEST_TIMEOUT_MS);

      const json = JSON.stringify(requestWithId);
      pending.frame = encodeFrame(Buffer.from(json, "utf-8"));
      this.pending.set(requestId, pending);

      try {
        gen.socket.write(pending.frame, (err) => {
          if (!err) return;
          // A write callback failure may mean the data partially reached the
          // daemon; only settle if nothing else already did.
          if (this.pending.get(requestId) !== pending) return;
          this.settleUncertain(pending, requestId, "Socket write failed");
        });
      } catch (err) {
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        reject(err as Error);
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connectPromise = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const gen = this.currentGeneration;
    this.currentGeneration = null;
    if (gen) {
      try { gen.socket.destroy(); } catch { /* best effort */ }
    }
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.settleUncertain(pending, requestId, "Transport closed");
    }
    this.pending.clear();
  }

  private async ensureConnected(): Promise<void> {
    const gen = this.currentGeneration;
    if (gen && !gen.socket.destroyed) return;

    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const conn = createConnection(this.socketPath, () => {
        if (this.closed) {
          try { conn.destroy(); } catch { /* best effort */ }
          reject(new Error("Transport closed during connect"));
          return;
        }
        const gen: ConnectionGeneration = {
          id: ++this.generationSeq,
          socket: conn,
          accumulator: createFrameAccumulator(),
        };
        this.currentGeneration = gen;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.reconnectAttempts = 0;
        // A response may have been lost with the previous connection. Replay
        // the exact original envelopes; the original requestId and
        // idempotency key are what make mutation replay safe.
        for (const pending of this.pending.values()) {
          try { conn.write(pending.frame); } catch { /* timeout/failure handles it */ }
        }
        resolve();
      });

      conn.on("data", (chunk: Buffer) => {
        const gen = this.currentGeneration;
        if (!gen || gen.socket !== conn) {
          // Stale generation: a later connection owns delivery now.
          logWarn(TAG, `Ignoring data from stale generation`);
          return;
        }
        try {
          gen.accumulator.push(chunk);
        } catch {
          // The stream is no longer frame-aligned; the request was already
          // written, so the mutation may have been accepted. Settle every
          // pending request as uncertain and let the close handler drive a
          // clean reconnect with exact-envelope replay.
          this.failPending(gen, "Frame error");
          try { conn.destroy(); } catch { /* best effort */ }
          return;
        }

        let frame: ReturnType<FrameAccumulator["readFrame"]>;
        while ((frame = gen.accumulator.readFrame()) !== null) {
          try {
            const text = frame.payload.toString("utf-8");
            const response = JSON.parse(text) as AbmindResponseV1;
            const requestId = response.requestId;
            const pending = this.pending.get(requestId);
            if (pending) {
              this.pending.delete(requestId);
              clearTimeout(pending.timer);
              if (!pending.settled) {
                pending.settled = true;
                pending.resolve(response);
              } else {
                // Response arrived after the request was already settled:
                // never double-settle, never trigger a second dispatch.
                logWarn(TAG, `Late response frame requestId=${requestId} generation=${gen.id}`);
              }
            } else {
              // Late/unmatched frame: never settles a removed entry and never
              // triggers a second dispatch.
              logWarn(TAG, `Late or unmatched response frame requestId=${requestId} generation=${gen.id}`);
            }
          } catch {
            // A malformed response frame cannot be correlated; the request
            // was written, so its outcome is uncertain, never definitive.
            this.failPending(gen, "Malformed response frame");
          }
        }
      });

      conn.on("close", () => {
        if (this.closed) return;
        const gen = this.currentGeneration;
        if (!gen || gen.socket !== conn) {
          // A stale old-socket close cannot clear the current generation,
          // reset attempts, or schedule an overlapping reconnect.
          logWarn(TAG, "Stale connection close ignored");
          return;
        }
        this.currentGeneration = null;
        this.scheduleReconnect();
      });

      conn.on("error", (err) => {
        const gen = this.currentGeneration;
        if (gen && gen.socket === conn) return; // close handler drives reconnect
        if (!this.currentGeneration) {
          reject(err);
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) return; // one owned reconnect attempt at a time
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.failPending(undefined, "Max reconnection attempts reached");
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.ensureConnected().catch(() => { /* connect failure: callers see unavailable */ });
    }, delay);
  }

  private settleTimeout(pending: PendingRecord, requestId: string): void {
    if (this.pending.get(requestId) !== pending) return;
    this.pending.delete(requestId);
    this.settleUncertain(pending, requestId, "Request timeout");
  }

  /** Settle an in-flight request whose outcome is uncertain. Settles once. */
  private settleUncertain(pending: PendingRecord, requestId: string, message: string): void {
    if (pending.settled) return;
    pending.settled = true;
    if (this.pending.get(requestId) === pending) this.pending.delete(requestId);
    clearTimeout(pending.timer);
    const errResponse: AbmindResponseV1 = {
      ok: false, requestId, error: uncertainFailureBody(pending.mutation, message),
    };
    pending.resolve(errResponse);
  }

  /**
   * Settle every pending request after a codec failure or reconnect
   * exhaustion. Every request was already written, so its outcome is
   * uncertain: mutations become outcome_unknown/reconcile, reads stay
   * retryable unavailable. When a generation is supplied, only that current
   * generation may be settled — stale generations are ignored.
   */
  private failPending(gen: ConnectionGeneration | undefined, message: string): void {
    if (gen !== undefined && this.currentGeneration !== gen) return;
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (pending.settled) continue;
      pending.settled = true;
      pending.resolve({ ok: false, requestId, error: uncertainFailureBody(pending.mutation, message) } as AbmindResponseV1);
    }
    this.pending.clear();
  }
}
