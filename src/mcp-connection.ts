/**
 * mcp-connection.ts — one connection owner for the MCP adapter (#1384).
 *
 * Centralizes local/remote selection, remote profile loading, client
 * construction, initial negotiation and awaited close. In remote mode it
 * also acquires the outbox namespace lease before opening/replaying
 * records and releases it after transport close. Local mode acquires no
 * lease and holds no delivery records, so several local MCP hosts start
 * and serve concurrently against one socket.
 *
 * Capabilities, route state, outbox counts and structured errors are read
 * from AbmindClient/the transports; this owner keeps no independent
 * capability cache, reconnect controller, retry loop or failure taxonomy.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AbmindClient } from "./abmind-client.js";
import type { AbmindCapabilitiesV1 } from "./abmind-protocol.js";
import { PRINCIPAL_ID_MAX } from "./abmind-protocol.js";
import type { AbmindRouteSnapshotV1 } from "./remote/route-contract.js";
import { abmindHome } from "./mem-paths.js";
import { getAbmindEnv } from "./env-schema.js";
import { ensurePrimaryUserId } from "./user-utils.js";
import {
  createOwnerLease, createProcessIdentityProvider, getCanonicalLeaseDir,
  OwnerLeaseError, type OwnerLease,
} from "./abmind-owner-lease.js";

export type McpConnectionMode = "local" | "remote";

export interface McpConnectionConfig {
  mode: McpConnectionMode;
  /** Explicit local socket selection; defaults to the configured endpoint. */
  socketPath?: string;
  /** Remote client-profile name (remote mode only). */
  remoteProfile?: string;
  /** Bound principal; every tool call is authorized as this identity. */
  principal: string;
  /** Stable operator-chosen identifier for one MCP host configuration. */
  instanceId: string;
}

export interface McpOutboxCounts {
  retryEligible: number;
  terminalUnknown: number;
}

const INSTANCE_ID_MAX = 64;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const CONTROL_CHAR = /[\x00-\x1f\x7f-\x9f]/;
export const MCP_CALL_TIMEOUT_MS = 30_000;

/** Bounded wall clock: startup and foreground waits share one ceiling. */
export function withMcpTimeout<T>(promise: Promise<T>, ms = MCP_CALL_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`MCP wait exceeded ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Validate an operator-chosen instance identifier (never a filesystem path). */
export function validateInstanceId(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("instance id must be a non-empty string");
  }
  const id = raw.trim();
  if (id.length > INSTANCE_ID_MAX || !INSTANCE_ID_PATTERN.test(id)) {
    throw new Error(`instance id must match [A-Za-z0-9._-]{1,${INSTANCE_ID_MAX}}`);
  }
  return id;
}

/** Validate a bound principal without guessing or substituting one. */
export function validatePrincipal(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("principal must be a non-empty string");
  }
  const id = raw.trim();
  if (id.length > PRINCIPAL_ID_MAX || CONTROL_CHAR.test(id)) {
    throw new Error(`principal must be 1-${PRINCIPAL_ID_MAX} characters without control characters`);
  }
  return id;
}

/**
 * Resolve the bound principal: explicit, or in local mode through
 * ABMIND_USER_ID/saved manifest identity. Remote mode requires an
 * explicit principal. No legacy users.json/master/default guess.
 */
export function resolveMcpPrincipal(mode: McpConnectionMode, explicit?: string): string {
  if (explicit !== undefined && explicit.trim() !== "") return validatePrincipal(explicit);
  if (mode === "remote") {
    throw new Error("abmind mcp --remote requires --principal <id>");
  }
  const saved = ensurePrimaryUserId();
  if (!saved) {
    throw new Error("no principal: pass --principal <id> or configure ABMIND_USER_ID / manifest identity");
  }
  return validatePrincipal(saved);
}

/** Validate an operation id supplied with a mutation (1-128 characters). */
export function validateOperationId(raw: unknown): string {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 128) {
    throw new Error("operationId must be 1-128 characters");
  }
  if (CONTROL_CHAR.test(raw)) {
    throw new Error("operationId must not contain control characters");
  }
  return raw;
}

/**
 * Derive the bounded transport idempotency key from instance, bound
 * principal, tool and operationId. The payload is excluded so changed
 * input under a reused id reaches the ledger's idempotency-conflict
 * check; the same id with the same payload converges.
 */
export function deriveIdempotencyKey(instanceId: string, principal: string, tool: string, operationId: string): string {
  const hash = createHash("sha256")
    .update(`mcp\0${instanceId}\0${principal}\0${tool}\0${operationId}`, "utf-8")
    .digest("hex")
    .slice(0, 32);
  return `mcp-${hash}`;
}

/** Stable outbox namespace for one remote MCP host configuration. */
export function mcpOutboxNamespace(
  instanceId: string, principal: string, url: string, peerId: string, serverCertSha256: string,
): { namespace: string; peerName: string } {
  const namespace = createHash("sha256")
    .update(`mcp-outbox-v1\0${instanceId}\0${principal}\0${url}\0${peerId}\0${serverCertSha256}`, "utf-8")
    .digest("hex");
  return { namespace, peerName: `mcp-${namespace.slice(0, 24)}` };
}

export function mcpOutboxFilePath(namespace: string): string {
  return join(abmindHome(), "remote", "outbox", `mcp-${namespace}.json`);
}

export class McpConnectionOwner {
  readonly mode: McpConnectionMode;
  readonly principal: string;
  readonly instanceId: string;

  private readonly socketPath?: string;
  private readonly remoteProfile?: string;
  private client_: AbmindClient | null = null;
  private lease_: OwnerLease | null = null;
  private cleanup_: Promise<void> | null = null;
  private started_ = false;

  constructor(config: McpConnectionConfig) {
    this.mode = config.mode;
    this.principal = validatePrincipal(config.principal);
    this.instanceId = validateInstanceId(config.instanceId);
    this.socketPath = config.socketPath;
    this.remoteProfile = config.remoteProfile;
  }

  get client(): AbmindClient {
    if (!this.client_) throw new Error("MCP connection is not started");
    return this.client_;
  }

  get started(): boolean {
    return this.started_;
  }

  get capabilities(): AbmindCapabilitiesV1 | null {
    return this.client_?.capabilities ?? null;
  }

  get routeSnapshot(): AbmindRouteSnapshotV1 {
    return this.client_?.routeSnapshot ?? {
      version: 1, state: "disconnected", generation: 0, retryEligible: 0, terminalUnknown: 0,
    };
  }

  /** True only when the current route can admit work. */
  isRouteReady(): boolean {
    return this.routeSnapshot.state === "ready";
  }

  /** Bounded outbox counts in remote mode; null in local mode. */
  outboxCounts(): McpOutboxCounts | null {
    if (this.mode !== "remote") return null;
    const snap = this.routeSnapshot;
    return { retryEligible: snap.retryEligible, terminalUnknown: snap.terminalUnknown };
  }

  async start(): Promise<void> {
    if (this.started_) return;
    if (this.mode === "local") {
      // Reuse the existing local client creation path (same transport
      // construction and negotiation as every other local consumer).
      const { createLocalClient } = await import("./backend-factory.js");
      const client = await withMcpTimeout(createLocalClient(this.socketPath ?? getAbmindEnv().localEndpoint));
      this.client_ = client;
      this.started_ = true;
      return;
    }
    await this.startRemote();
    this.started_ = true;
  }

  private async startRemote(): Promise<void> {
    if (!this.remoteProfile) {
      throw new Error("abmind mcp --remote requires --remote <profile>");
    }
    const { loadClientProfiles } = await import("./remote/remote-config.js");
    const profile = loadClientProfiles().find((p) => p.name === this.remoteProfile);
    if (!profile) {
      throw new Error(`unknown remote profile: ${this.remoteProfile}`);
    }
    const { namespace, peerName } = mcpOutboxNamespace(
      this.instanceId, this.principal, profile.url, profile.peerId, profile.serverCertSha256,
    );
    const outboxPath = mcpOutboxFilePath(namespace);
    mkdirSync(join(abmindHome(), "remote", "outbox"), { recursive: true, mode: 0o700 });

    // Exclusive ownership of this namespace before opening or replaying
    // any record, via the existing owner-lease contract (pid plus
    // platform process-start token, atomic rename, re-verified
    // takeover). A live owner refuses startup; an unverifiable previous
    // owner fails closed; only a definitive dead verdict permits
    // recovery, which preserves the existing records.
    const lease = await createOwnerLease({
      runRoot: getCanonicalLeaseDir(),
      databasePath: outboxPath,
      mode: "embedded",
      processIdentity: createProcessIdentityProvider(),
    });
    try {
      await lease.acquire();
    } catch (err) {
      if (err instanceof OwnerLeaseError) {
        throw new Error(
          `MCP remote outbox namespace is already owned — give each concurrent remote host a distinct --instance-id: ${err.message}`,
        );
      }
      throw err;
    }
    this.lease_ = lease;

    try {
      const { RequestOutbox } = await import("./remote/request-outbox.js");
      const outbox = new RequestOutbox(peerName, outboxPath);
      if (outbox.isQuarantined) {
        throw new Error(`MCP remote outbox is quarantined (corrupt state preserved alongside): ${outboxPath}`);
      }
      const { SignedWssTransport } = await import("./remote/signed-wss-transport.js");
      const transport = new SignedWssTransport(profile, outbox);
      const client = new AbmindClient(transport);
      try {
        await withMcpTimeout(client.negotiate());
      } catch (err) {
        await client.close().catch(() => {});
        throw err;
      }
      this.client_ = client;
      // Private file permissions for the namespace state (best effort;
      // the 0700 parent directory is the primary protection).
      try {
        if (existsSync(outboxPath)) chmodSync(outboxPath, 0o600);
      } catch { /* best effort */ }
    } catch (err) {
      // Startup failure after resource acquisition unwinds everything so
      // the matching instance can reopen afterward with its records and
      // no orphaned owner.
      await this.lease_.release().catch(() => {});
      this.lease_ = null;
      throw err;
    }
  }

  /** Bounded renegotiation against the current connection. */
  async renegotiate(): Promise<AbmindCapabilitiesV1> {
    return withMcpTimeout(this.client.negotiate());
  }

  /**
   * Awaited close: transport first, then the remote lease. Repeated
   * shutdown requests share one cleanup operation; it runs once.
   */
  close(): Promise<void> {
    if (!this.cleanup_) {
      const client = this.client_;
      const lease = this.lease_;
      this.cleanup_ = (async () => {
        try {
          await client?.close();
        } catch { /* best effort */ }
        try {
          await lease?.release();
        } catch { /* best effort */ }
      })();
    }
    return this.cleanup_;
  }
}
