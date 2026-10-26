/**
 * request-fingerprint.ts — One-way SHA-256 fingerprints for request metadata
 * (#1659).
 *
 * Used to log truncated idempotency-key fingerprints without ever logging raw
 * keys, and by the request ledger for the same purpose. Package-internal.
 */
import { createHash } from "node:crypto";

/** One-way truncated fingerprint; never reversible to the input value. */
export function fingerprint(value: string, len: number): string {
  return createHash("sha256").update(value, "utf-8").digest("hex").slice(0, len);
}
