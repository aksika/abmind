/**
 * Transport-neutral route and delivery contract for the signed-WSS remote
 * surface (#1382).
 *
 * Both the abmind daemon-side client and the independently shipped abtars
 * client implement the same observable state/admission/retry contract. This
 * module is the abmind copy; abtars keeps structural copies protected by
 * cross-package conformance tests. No snapshot or diagnostic value in this
 * module ever contains URLs, profile paths, payloads, memory content, private
 * keys, signatures, nonces, credentials, or free-form remote error text.
 */

/** Public route states, in lifecycle order. */
export type AbmindRouteState =
  | "closed"
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "negotiating"
  | "ready"
  | "reconnecting"
  | "unavailable";

/** Bounded closed reason vocabulary for route-level failures. */
export type AbmindRouteReasonCode =
  | "route_unavailable"
  | "connection_failed"
  | "pin_mismatch"
  | "authentication_failed"
  | "negotiation_failed"
  | "policy_rejected"
  | "retry_exhausted"
  | "transport_closed";

/** Read-only bounded route snapshot exposed to callers and diagnostics. */
export interface AbmindRouteSnapshotV1 {
  version: 1;
  state: AbmindRouteState;
  generation: number;
  reasonCode?: AbmindRouteReasonCode;
  retryEligible: number;
  terminalUnknown: number;
  nextAttemptAt?: number;
}

/** Durable delivery state of one admitted logical request. */
export type AbmindDeliveryState =
  | "admitted"
  | "in_flight"
  | "retry_wait"
  | "terminal_unknown";

/**
 * Bounded last-failure classification for retryable (transport-uncertain)
 * failures. Contains no payload, body, or secret.
 */
export type RetryFailureClass =
  | "timeout"
  | "send_failed"
  | "socket_lost"
  | "generation_lost"
  | "connection_refused";

/** Terminal service-level error codes that are never automatically resent. */
export const TERMINAL_SERVICE_ERROR_CODES = [
  "validation_error",
  "unauthorized",
  "unsupported_method",
  "unsupported_version",
  "idempotency_conflict",
  "conflict",
  "not_found",
  "audit_failure",
  "internal_error",
] as const;

// ── Bounded retry / reconnect constants (identical copies in abtars) ──────

/** Maximum send attempts per admitted entry (including the first send). */
export const ROUTE_RETRY_MAX_ATTEMPTS = 5;
/** Overall persisted wall-clock retry deadline from admission. */
export const ROUTE_RETRY_DEADLINE_MS = 15 * 60_000;
/** Base delay for retry backoff. */
export const ROUTE_RETRY_BASE_MS = 1_000;
/** Maximum delay for retry backoff. */
export const ROUTE_RETRY_MAX_MS = 60_000;
/** Maximum jitter added to any backoff delay. */
export const ROUTE_RETRY_JITTER_MS = 250;
/** Maximum terminal-unknown records retained. */
export const ROUTE_TERMINAL_UNKNOWN_MAX_ENTRIES = 50;
/** Retention window for terminal-unknown records before explicit cleanup. */
export const ROUTE_TERMINAL_UNKNOWN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Maximum length of a method string in a durable outbox entry. */
export const ROUTE_METHOD_MAX_BYTES = 128;

/**
 * Fixed cross-package conformance vectors. Both independently shipped clients
 * must agree on logical request identity, retryable-versus-terminal
 * classification, and which auth fields are refreshed per send.
 */
export const ABMIND_ROUTE_CONFORMANCE_V1 = {
  version: 1,
  routeStates: [
    "closed", "disconnected", "connecting", "authenticating",
    "negotiating", "ready", "reconnecting", "unavailable",
  ] as const,
  deliveryStates: ["admitted", "in_flight", "retry_wait", "terminal_unknown"] as const,
  reasonCodes: [
    "route_unavailable", "connection_failed", "pin_mismatch",
    "authentication_failed", "negotiation_failed", "policy_rejected",
    "retry_exhausted", "transport_closed",
  ] as const,
  retryableFailureClasses: [
    "timeout", "send_failed", "socket_lost", "generation_lost", "connection_refused",
  ] as const,
  terminalServiceErrorCodes: TERMINAL_SERVICE_ERROR_CODES,
  /** Preserved unchanged across every resend. */
  logicalIdentity: ["frameId", "requestId", "method", "body", "idempotencyKey"] as const,
  /** Regenerated for every send attempt so nonce replay prevention holds. */
  freshAuthFields: ["ts", "nonce", "sig"] as const,
  bounds: {
    maxAttempts: ROUTE_RETRY_MAX_ATTEMPTS,
    deadlineMs: ROUTE_RETRY_DEADLINE_MS,
    backoffBaseMs: ROUTE_RETRY_BASE_MS,
    backoffMaxMs: ROUTE_RETRY_MAX_MS,
    jitterMs: ROUTE_RETRY_JITTER_MS,
    terminalUnknownMaxEntries: ROUTE_TERMINAL_UNKNOWN_MAX_ENTRIES,
    terminalUnknownRetentionMs: ROUTE_TERMINAL_UNKNOWN_RETENTION_MS,
    methodMaxBytes: ROUTE_METHOD_MAX_BYTES,
  },
} as const;
