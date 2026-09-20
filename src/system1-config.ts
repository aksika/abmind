/**
 * system1-config.ts — #1812 pure validated System One configuration resolver.
 *
 * Single owner for provider construction AND display (status, doctor, boot
 * log): every consumer calls resolveSystem1Config(getAbmindEnv()) instead of
 * re-parsing env. Returns a closed union — callers branch on `state`, never
 * on parallel flags. Invalid input disables the capability with a static
 * actionable diagnostic; raw values are never echoed (config can hold
 * secrets).
 */

import type { AbmindEnvConfig } from "./env-schema.js";

export type System1Backend = "jev" | "laya";

interface System1Common {
  readonly recallEnabled: boolean;
  readonly timeoutMs: number;
  readonly maxCandidates: number;
  /** Validated full endpoint URL (bare: no credentials, query, or fragment). */
  readonly url: string;
  /** Sanitized endpoint host for display (host[:port], never credentials). */
  readonly endpoint: string;
}

export type System1Config =
  | { readonly state: "off"; readonly recallRequested: boolean }
  | ({ readonly state: "on" } & System1Common & (
    | { readonly backend: "jev"; readonly model: string; readonly keyPresent: boolean }
    | { readonly backend: "laya" }
  ))
  | { readonly state: "invalid"; readonly reason: string; readonly backend: System1Backend | null; readonly recallRequested: boolean };

const JEV_MODEL_PIN = /^jev-\d+\.\d+(\.\d+)?$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Parse a URL, returning null instead of throwing on garbage input. */
function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    // Not a parseable URL — invalid configuration, not a crash.
    return null;
  }
}

/** Reject credential-bearing or decorated URLs; endpoint identity must be bare. */
function urlIsBare(u: URL): boolean {
  return u.username === "" && u.password === "" && u.search === "" && u.hash === "";
}

/** Resolve and validate the effective System One configuration. Pure. */
export function resolveSystem1Config(env: Readonly<AbmindEnvConfig>): System1Config {
  const common: Omit<System1Common, "url" | "endpoint"> = {
    recallEnabled: env.system1RecallEnabled,
    timeoutMs: env.system1TimeoutMs,
    maxCandidates: env.system1MaxCandidates,
  };

  if (env.system1Selector === "off" || env.system1Selector === "") {
    return { state: "off", recallRequested: env.system1RecallEnabled };
  }
  if (env.system1Selector === "jev") {
    const u = parseUrl(env.jevUrl);
    if (!u) return { state: "invalid", reason: "JEV_URL is not a valid URL", backend: "jev", recallRequested: env.system1RecallEnabled };
    if (u.protocol !== "https:" || !urlIsBare(u)) {
      return { state: "invalid", reason: "JEV_URL must be a bare https URL without credentials, query, or fragment", backend: "jev", recallRequested: env.system1RecallEnabled };
    }
    if (!JEV_MODEL_PIN.test(env.jevModel)) {
      return { state: "invalid", reason: "JEV_MODEL must be a pinned jev version (for example jev-1.13.0), never jev-latest", backend: "jev", recallRequested: env.system1RecallEnabled };
    }
    if (!env.jevApiKey) {
      return { state: "invalid", reason: "SYSTEM1=jev needs JEV_API_KEY", backend: "jev", recallRequested: env.system1RecallEnabled };
    }
    return {
      state: "on", backend: "jev", ...common,
      url: u.toString(), endpoint: u.host, model: env.jevModel, keyPresent: true,
    };
  }
  if (env.system1Selector === "laya") {
    const u = parseUrl(env.layaUrl);
    if (!u) return { state: "invalid", reason: "LAYA_URL is not a valid URL", backend: "laya", recallRequested: env.system1RecallEnabled };
    if (!urlIsBare(u) || !LOOPBACK_HOSTS.has(u.hostname)) {
      return { state: "invalid", reason: "LAYA_URL must be a bare loopback URL (127.0.0.1, ::1, or localhost)", backend: "laya", recallRequested: env.system1RecallEnabled };
    }
    return { state: "on", backend: "laya", ...common, url: u.toString(), endpoint: u.host };
  }
  return { state: "invalid", reason: "SYSTEM1 must be off, jev, or laya", backend: null, recallRequested: env.system1RecallEnabled };
}
