import { randomBytes, sign, verify, timingSafeEqual, generateKeyPairSync } from "node:crypto";
import { createPublicKey, createPrivateKey } from "node:crypto";
import {
  buildRequestCanonical, buildHelloCanonical, WSS_TIMESTAMP_WINDOW_SEC,
  WSS_NONCE_BYTES, WSS_PEER_ID_MAX, WSS_FRAME_ID_MAX,
  type WssAuthFields,
} from "./signed-wire.js";

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX32_RE = /^[0-9a-f]{32}$/;

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_fields" | "invalid_ts" | "stale_ts" | "invalid_nonce" | "invalid_sig" | "bad_sig" | "peer_too_long" | "id_too_long" };

function edSign(privateKeyPem: string, message: string): string {
  const key = createPrivateKey(privateKeyPem);
  const sig = sign(null, Buffer.from(message, "utf-8"), key);
  return sig.toString("base64");
}

function edVerify(publicKeySpki: string, message: string, sigBase64: string): boolean {
  try {
    const key = createPublicKey(publicKeySpki);
    return verify(null, Buffer.from(message, "utf-8"), key, Buffer.from(sigBase64, "base64"));
  } catch {
    return false;
  }
}

export function signHello(
  peerId: string,
  connectionId: string,
  challenge: string,
  timestamp: string,
  signingKey: string,
): string {
  const canonical = buildHelloCanonical(1, peerId, connectionId, challenge, timestamp);
  return edSign(signingKey, canonical);
}

export function verifyHello(
  peerId: string,
  connectionId: string,
  challenge: string,
  timestamp: string,
  signature: string,
  verifyKey: string,
): VerifyResult {
  if (!peerId || !connectionId || !challenge || !timestamp || !signature) {
    return { ok: false, reason: "missing_fields" };
  }
  if (peerId.length > WSS_PEER_ID_MAX) return { ok: false, reason: "peer_too_long" };

  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: "invalid_ts" };
  const ts = Number(timestamp);
  if (!Number.isSafeInteger(ts)) return { ok: false, reason: "invalid_ts" };
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > WSS_TIMESTAMP_WINDOW_SEC) return { ok: false, reason: "stale_ts" };

  const canonical = buildHelloCanonical(1, peerId, connectionId, challenge, timestamp);
  if (!edVerify(verifyKey, canonical, signature)) return { ok: false, reason: "bad_sig" };
  return { ok: true };
}

export function signRequest(
  peerId: string,
  frameId: string,
  body: string,
  signingKey: string,
): WssAuthFields & { ts: string; nonce: string } {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(WSS_NONCE_BYTES).toString("hex");
  const canonical = buildRequestCanonical(1, peerId, frameId, "abmind.request.v1", "/abmind.request.v1", ts, nonce, body);
  const sig = edSign(signingKey, canonical);
  return { peerId, ts, nonce, sig };
}

export function verifyRequestSignature(
  auth: WssAuthFields,
  frameId: string,
  body: string,
  verifyKey: string,
): VerifyResult {
  const { peerId, ts: tsStr, nonce, sig } = auth;

  if (!peerId || !tsStr || !nonce || !sig) return { ok: false, reason: "missing_fields" };
  if (peerId.length > WSS_PEER_ID_MAX) return { ok: false, reason: "peer_too_long" };
  if (frameId.length > WSS_FRAME_ID_MAX) return { ok: false, reason: "id_too_long" };

  if (!/^\d+$/.test(tsStr)) return { ok: false, reason: "invalid_ts" };
  if (!HEX32_RE.test(nonce)) return { ok: false, reason: "invalid_nonce" };
  if (sig.length % 4 !== 0 || !BASE64_RE.test(sig)) return { ok: false, reason: "invalid_sig" };

  const ts = Number(tsStr);
  if (!Number.isSafeInteger(ts)) return { ok: false, reason: "invalid_ts" };
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > WSS_TIMESTAMP_WINDOW_SEC) return { ok: false, reason: "stale_ts" };

  const canonical = buildRequestCanonical(1, peerId, frameId, "abmind.request.v1", "/abmind.request.v1", tsStr, nonce, body);
  if (!edVerify(verifyKey, canonical, sig)) return { ok: false, reason: "bad_sig" };
  return { ok: true };
}

export function generateSigningKey(): { privateKeyPem: string; publicKeySpki: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeySpki: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export function deriveVerifyKey(privateKeyPem: string): string {
  const key = createPublicKey({ key: privateKeyPem, format: "pem" });
  return key.export({ type: "spki", format: "pem" }).toString();
}

export function verifyCertificatePin(
  certPem: string,
  expectedSpkiBase64: string,
): boolean {
  try {
    const certKey = createPublicKey(certPem);
    const actualSpki = certKey.export({ type: "spki", format: "der" }).toString("base64");
    if (actualSpki.length !== expectedSpkiBase64.length) return false;
    return timingSafeEqual(Buffer.from(actualSpki), Buffer.from(expectedSpkiBase64));
  } catch {
    return false;
  }
}

export { randomBytes } from "node:crypto";
