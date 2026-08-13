import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { createFrameAccumulator, encodeFrame, REQUEST_TIMEOUT_MS, RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS, RECONNECT_MAX_ATTEMPTS, type FrameAccumulator } from "./abmind-frame-codec.js";
import type { AbmindMethod, AbmindRequestV1, AbmindResponseV1, AbmindCapabilitiesV1, AbmindTransport, AbmindErrorBodyV1, AbmindErrorCodeV1 } from "./abmind-protocol.js";
import { ABMIND_PROTOCOL_VERSION, errorBodyV1, isMutatingMethod } from "./abmind-protocol.js";

interface PendingRecord {
  resolve: (value: AbmindResponseV1) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  frame: Buffer;
  /** Mutation requests classify post-write uncertainty as outcome_unknown. */
  mutation: boolean;
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
  private socket: Socket | null = null;
  private acc: FrameAccumulator = createFrameAccumulator();
  private pending = new Map<string, PendingRecord>();
  private connectPromise: Promise<void> | null = null;
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

    return new Promise<AbmindResponseV1<K>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const errResponse: AbmindResponseV1<K> = {
          ok: false, requestId, error: uncertainFailureBody(mutation, "Request timeout"),
        } as AbmindResponseV1<K>;
        resolve(errResponse);
      }, REQUEST_TIMEOUT_MS);

      const json = JSON.stringify(requestWithId);
      const frame = encodeFrame(Buffer.from(json, "utf-8"));
      this.pending.set(requestId, { resolve: resolve as (v: AbmindResponseV1) => void, reject, timer, frame, mutation });

      try {
        this.socket!.write(frame);
      } catch (err) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connectPromise = null;
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* best effort */ }
      this.socket = null;
    }
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Transport closed"));
    }
    this.pending.clear();
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;

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
        this.reconnectAttempts = 0;
        this.socket = conn;
        // A response may have been lost with the previous connection. Replay
        // the exact original envelopes; the original requestId and
        // idempotency key are what make mutation replay safe.
        for (const pending of this.pending.values()) {
          try { conn.write(pending.frame); } catch { /* timeout/failure handles it */ }
        }
        resolve();
      });

      conn.on("data", (chunk: Buffer) => {
        try {
          this.acc.push(chunk);
        } catch {
          this.failPending("validation_error", "Frame error");
          return;
        }

        let frame: ReturnType<FrameAccumulator["readFrame"]>;
        while ((frame = this.acc.readFrame()) !== null) {
          try {
            const text = frame.payload.toString("utf-8");
            const response = JSON.parse(text) as AbmindResponseV1;
            const requestId = response.requestId;
            const pending = this.pending.get(requestId);
            if (pending) {
              this.pending.delete(requestId);
              clearTimeout(pending.timer);
              pending.resolve(response);
            }
          } catch {
            this.failPending("validation_error", "Malformed response frame");
          }
        }
      });

      conn.on("close", () => {
        if (this.closed) return;
        if (this.socket === conn) this.socket = null;
        this.acc = createFrameAccumulator();
        this.scheduleReconnect();
      });

      conn.on("error", (err) => {
        if (!this.socket) {
          reject(err);
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.failPending("reconnect_exhausted", "Max reconnection attempts reached");
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
      RECONNECT_MAX_DELAY_MS,
    );
    setTimeout(() => {
      if (this.closed) return;
      this.connectPromise = null;
      this.ensureConnected().catch(() => {});
    }, delay);
  }

  private failPending(code: AbmindErrorCodeV1 | "reconnect_exhausted", message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      const body = code === "reconnect_exhausted"
        ? uncertainFailureBody(pending.mutation, message)
        : errorBodyV1(code, message, "response");
      const errResp: AbmindResponseV1 = {
        ok: false, requestId: id, error: body,
      };
      pending.resolve(errResp);
    }
    this.pending.clear();
  }
}
