import { createHash } from "node:crypto";
import type { AbmindMethod, AbmindRequestV1, AbmindResponseV1 } from "../abmind-protocol.js";

export const ABMIND_WSS_PROTOCOL_VERSION = 1 as const;
export const ABMIND_WSS_DOMAIN_HELLO = "abmind-wss-hello-v1";
export const ABMIND_WSS_DOMAIN_REQUEST = "abmind-wss-request-v1";

export const WSS_HELLO_CHALLENGE_BYTES = 32;
export const WSS_HELLO_EXPIRY_MS = 30_000;
export const WSS_PEER_ID_MAX = 128;
export const WSS_CONNECTION_ID_MAX = 64;
export const WSS_FRAME_ID_MAX = 64;
export const WSS_MAX_RAW_FRAME_BYTES = 2_000_000;
export const WSS_MAX_BODY_BYTES = 1_000_000;
export const WSS_NONCE_BYTES = 16;
export const WSS_TIMESTAMP_WINDOW_SEC = 30;
export const WSS_AUTH_RESPONSE_MAX_BYTES = 4096;
export const WSS_MAX_INFLIGHT = 64;
export const WSS_MAX_QUEUED_WRITE_BYTES = 16_000_000;
export const WSS_HANDSHAKE_TIMEOUT_MS = 15_000;
export const WSS_REQUEST_TIMEOUT_MS = 120_000;
export const WSS_IDLE_TIMEOUT_MS = 300_000;
export const WSS_RECONNECT_BASE_MS = 1_000;
export const WSS_RECONNECT_MAX_MS = 60_000;
export const WSS_RECONNECT_MAX_ATTEMPTS = 10;
export const WSS_OUTBOX_MAX_ENTRIES = 200;
export const WSS_OUTBOX_MAX_ENTRY_BYTES = 524_288;
export const WSS_OUTBOX_MAX_FILE_BYTES = 10_000_000;

export interface SignedHelloV1 {
  type: "hello";
  version: 1;
  peerId: string;
  connectionId: string;
  challenge: string;
  timestamp: string;
  signature: string;
}

export interface WssAuthFields {
  peerId: string;
  ts: string;
  nonce: string;
  sig: string;
}

export interface SignedAbmindRequestFrameV1 {
  type: "request";
  version: 1;
  id: string;
  method: "abmind.request.v1";
  body: string;
  auth: WssAuthFields;
}

export interface AbmindResponseFrameV1 {
  type: "response";
  version: 1;
  id: string;
  body: string;
}

export type WssServerFrameV1 = SignedAbmindRequestFrameV1;
export type WssClientFrameV1 = SignedAbmindRequestFrameV1 | SignedHelloV1;

export interface WssTransportCapabilities {
  version: number;
  supportedAuth: string[];
  methods: string[];
}

export function buildRequestCanonical(
  version: number,
  peerId: string,
  frameId: string,
  method: string,
  path: string,
  ts: string,
  nonce: string,
  body: string,
): string {
  const bodyHash = createHash("sha256").update(body, "utf-8").digest("hex");
  return `${ABMIND_WSS_DOMAIN_REQUEST}\n${version}\n${peerId}\n${frameId}\n${method}\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
}

export function buildHelloCanonical(
  version: number,
  peerId: string,
  connectionId: string,
  challenge: string,
  timestamp: string,
): string {
  return `${ABMIND_WSS_DOMAIN_HELLO}\n${version}\n${peerId}\n${connectionId}\n${challenge}\n${timestamp}`;
}
