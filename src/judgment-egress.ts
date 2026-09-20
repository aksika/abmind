/**
 * judgment-egress.ts — #1813 owner-side privacy gate for System One judgments.
 *
 * Every judgment operation (inherited rerank plus lookup/repeat/attribution)
 * passes this gate before serializing a payload. Laya is loopback-only by
 * config (system1-config.ts enforces the loopback URL), so it needs no grant.
 * Jev sends state off-box: each operation needs an explicit operator grant via
 * SYSTEM1_JEV_EGRESS, and enabling a fast-path flag is never SaaS permission.
 * Unknown providers abstain — retrieval permission is not SaaS consent.
 */

import { getAbmindEnv } from "./env-schema.js";

export type JudgmentOperation = "rerank" | "lookup" | "repeat" | "attribution";

export type EgressVerdict =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: "jev-egress-not-granted" | "unknown-provider" };

/** Owner-side egress check. Pure apart from the env read; never throws. */
export function checkJudgmentEgress(
  providerName: string,
  operation: JudgmentOperation,
): EgressVerdict {
  if (providerName === "laya") return { allow: true };
  if (providerName === "jev") {
    const granted = getAbmindEnv().system1JevEgressOps.includes(operation);
    return granted
      ? { allow: true }
      : { allow: false, reason: "jev-egress-not-granted" };
  }
  return { allow: false, reason: "unknown-provider" };
}
