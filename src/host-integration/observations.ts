/**
 * #1383 — provider-neutral host observation sink (feedback v1).
 *
 * Hosts report evidence with provenance; abmind validates, counts, and
 * returns a receipt. The v1 revision/lineage consumer is diagnostic-only:
 * no raw payload is retained, no durable journal is created, and no
 * cite/reject counters move. Delegation outcomes are observed but
 * unsupported until a real #1373 consumer exists. Deduplication is a bounded
 * volatile event-ID window: restarts reset it, which is reported, not hidden.
 *
 * Nothing textual from an observation is logged or echoed: validation errors
 * are static strings, receipts carry IDs and counters only.
 */
import type { ExecutionIdentity } from "./types.js";

export const OBSERVATION_VERSION = 1 as const;
/** Maximum tracked event IDs; oldest evicted first. */
export const OBSERVATION_WINDOW_MAX = 1000;
/** Event-ID lifetime in milliseconds. */
export const OBSERVATION_WINDOW_TTL_MS = 3_600_000;

export type ObservationKind =
  | "committed-revision"
  | "session-lineage"
  | "delegation-outcome";

export interface ObservationInput {
  version: number;
  eventId: string;
  identity: ExecutionIdentity;
  occurredAt: number;
  kind: string;
  payload: Record<string, unknown>;
}

export type ObservationConsumer = "diagnostic-only" | "delegated" | "unsupported" | "none";

export interface ObservationReceipt {
  eventId: string;
  consumer: ObservationConsumer;
  status: "received" | "duplicate" | "rejected" | "unavailable";
  reason: string;
}

const MAX_TEXT = 2000;
const MAX_ID = 256;

function isBoundedText(v: unknown, max = MAX_TEXT): v is string {
  return typeof v === "string" && v.length <= max;
}

export class ObservationSink {
  private seen = new Map<string, number>();
  private counts = new Map<string, number>();

  countFor(kind: string, consumer: string): number {
    return this.counts.get(`${kind}:${consumer}`) ?? 0;
  }

  observe(input: ObservationInput): ObservationReceipt {
    const eventId = typeof (input as ObservationInput | null)?.eventId === "string"
      ? (input as ObservationInput).eventId
      : "";
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return ObservationSink.reject(eventId, "observation must be an object");
    }
    if (input.version !== OBSERVATION_VERSION) {
      return ObservationSink.reject(eventId, "unsupported observation version");
    }
    if (typeof input.eventId !== "string" || !input.eventId.trim() || input.eventId.length > 128) {
      return ObservationSink.reject(eventId, "eventId must be a non-empty string within 128 chars");
    }
    if (typeof input.occurredAt !== "number" || !Number.isFinite(input.occurredAt) || input.occurredAt < 0) {
      return ObservationSink.reject(eventId, "occurredAt must be a finite non-negative number");
    }
    if (input.kind !== "committed-revision" && input.kind !== "session-lineage" && input.kind !== "delegation-outcome") {
      return ObservationSink.reject(eventId, "unknown observation kind");
    }
    if (typeof input.payload !== "object" || input.payload === null || Array.isArray(input.payload)) {
      return ObservationSink.reject(eventId, "payload must be an object");
    }
    const kindError = ObservationSink.checkKind(input.kind, input.payload);
    if (kindError) return ObservationSink.reject(eventId, kindError);

    this.evictExpired(Date.now());
    if (this.seen.has(eventId)) {
      return { eventId, consumer: this.consumerFor(input.kind), status: "duplicate", reason: "event already received inside the window" };
    }
    this.seen.set(eventId, Date.now());
    while (this.seen.size > OBSERVATION_WINDOW_MAX) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
    const consumer = this.consumerFor(input.kind);
    this.counts.set(`${input.kind}:${consumer}`, (this.counts.get(`${input.kind}:${consumer}`) ?? 0) + 1);
    if (consumer === "unsupported") {
      return { eventId, consumer, status: "received", reason: "observed; no authorized consumer for delegation outcomes" };
    }
    return { eventId, consumer, status: "received", reason: "diagnostic receipt only; nothing retained" };
  }

  private consumerFor(kind: string): ObservationConsumer {
    return kind === "delegation-outcome" ? "unsupported" : "diagnostic-only";
  }

  private static checkKind(kind: string, payload: Record<string, unknown>): string | null {
    if (kind === "committed-revision") {
      const action = payload.action;
      if (action !== "add" && action !== "replace" && action !== "remove") {
        return "revision action must be add, replace, or remove";
      }
      if (!isBoundedText(payload.target, 64) || !(payload.target as string).trim()) {
        return "revision target must be a non-empty string within 64 chars";
      }
      const oldText = typeof payload.oldText === "string" ? payload.oldText : "";
      const newText = typeof payload.newText === "string" ? payload.newText : "";
      if (oldText.length > MAX_TEXT || newText.length > MAX_TEXT) {
        return "revision text exceeds the bounded payload";
      }
      if (!oldText.trim() && !newText.trim()) {
        return "revision requires old or new text";
      }
      if (payload.origin !== undefined && !isBoundedText(payload.origin, 128)) {
        return "revision origin exceeds the bounded payload";
      }
      return null;
    }
    if (kind === "session-lineage") {
      if (!isBoundedText(payload.reason, 64) || !(payload.reason as string).trim()) {
        return "lineage reason must be a non-empty string within 64 chars";
      }
      if (payload.parent !== undefined && !isBoundedText(payload.parent, MAX_ID)) {
        return "lineage parent exceeds the bounded payload";
      }
      if (payload.extentUnknown !== undefined && typeof payload.extentUnknown !== "boolean") {
        return "lineage extentUnknown must be a boolean";
      }
      return null;
    }
    if (!isBoundedText(payload.task, MAX_TEXT) || !(payload.task as string).trim()) {
      return "delegation task must be a non-empty string within 2000 chars";
    }
    if (payload.result !== undefined && !isBoundedText(payload.result, MAX_TEXT)) {
      return "delegation result exceeds the bounded payload";
    }
    if (payload.child !== undefined && !isBoundedText(payload.child, MAX_ID)) {
      return "delegation child exceeds the bounded payload";
    }
    return null;
  }

  private static reject(eventId: string, message: string): ObservationReceipt {
    return { eventId, consumer: "none", status: "rejected", reason: message };
  }

  private evictExpired(now: number): void {
    for (const [id, at] of this.seen) {
      if (now - at > OBSERVATION_WINDOW_TTL_MS) this.seen.delete(id);
      else break;
    }
  }
}
