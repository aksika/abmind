import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { DomainName, AbmindMethod } from "../abmind-protocol.js";
import { METHOD_REGISTRY } from "../abmind-protocol.js";
import { WSS_PEER_ID_MAX } from "./signed-wire.js";

export interface RemoteEndpointConfig {
  enabled: boolean;
  host: string;
  port: number;
  tlsCertPath: string;
  tlsKeyPath: string;
}

export interface RemoteEnrollmentV1 {
  peerId: string;
  verifyKey: string;
  enrolledAt: string;
}

export interface RemoteGrantV1 {
  peerId: string;
  principalId: string;
  domains: DomainName[];
  methods: AbmindMethod[];
  capabilities: string[];
  privateUserId?: string;
}

export interface RemoteClientProfileV1 {
  name: string;
  url: `wss://${string}`;
  peerId: string;
  signingKeyPath: string;
  serverCertSha256: string;
}

export interface RemoteConfig {
  endpoint: RemoteEndpointConfig;
  enrollments: RemoteEnrollmentV1[];
  grants: RemoteGrantV1[];
  clientProfiles: RemoteClientProfileV1[];
}

const VERSION_RE = /^\d+\.\d+\.\d+$/;

function remoteDir(): string {
  return process.env.ABMIND_REMOTE_DIR ?? join(abmindHome(), "remote");
}

export function loadEndpointConfig(): RemoteEndpointConfig {
  const p = join(remoteDir(), "endpoint.json");
  const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<RemoteEndpointConfig>;
  if (raw.enabled === true) {
    if (!raw.host || !raw.port || !raw.tlsCertPath || !raw.tlsKeyPath) {
      throw new Error("endpoint.json: enabled=true requires host, port, tlsCertPath, tlsKeyPath");
    }
    if (!existsSync(raw.tlsCertPath)) throw new Error(`endpoint.json: TLS cert not found: ${raw.tlsCertPath}`);
    if (!existsSync(raw.tlsKeyPath)) throw new Error(`endpoint.json: TLS key not found: ${raw.tlsKeyPath}`);
  }
  return {
    enabled: raw.enabled ?? false,
    host: raw.host ?? "",
    port: raw.port ?? 0,
    tlsCertPath: raw.tlsCertPath ?? "",
    tlsKeyPath: raw.tlsKeyPath ?? "",
  };
}

export function loadEnrollments(): RemoteEnrollmentV1[] {
  const p = join(remoteDir(), "enrollments.json");
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, "utf-8")) as RemoteEnrollmentV1[];
  if (!Array.isArray(raw)) throw new Error("enrollments.json: must be an array");
  const seen = new Set<string>();
  for (const e of raw) {
    if (!e.peerId || !e.verifyKey || !e.enrolledAt) throw new Error(`enrollments.json: invalid entry`);
    if (e.peerId.length > WSS_PEER_ID_MAX) throw new Error(`enrollments.json: peerId too long: ${e.peerId}`);
    if (seen.has(e.peerId)) throw new Error(`enrollments.json: duplicate peerId: ${e.peerId}`);
    seen.add(e.peerId);
  }
  return raw;
}

export function loadGrants(): RemoteGrantV1[] {
  const p = join(remoteDir(), "grants.json");
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, "utf-8")) as RemoteGrantV1[];
  if (!Array.isArray(raw)) throw new Error("grants.json: must be an array");
  for (const g of raw) {
    if (!g.peerId || !g.principalId || !Array.isArray(g.domains) || !Array.isArray(g.methods)) {
      throw new Error(`grants.json: invalid entry for peerId=${g.peerId ?? "?"}`);
    }
    for (const m of g.methods) {
      if (!(m in METHOD_REGISTRY)) {
        throw new Error(`grants.json: unknown method ${m} for peerId=${g.peerId}`);
      }
    }
    if (g.privateUserId !== undefined && typeof g.privateUserId !== "string") {
      throw new Error(`grants.json: privateUserId must be a string`);
    }
  }
  return raw;
}

export function loadClientProfiles(): RemoteClientProfileV1[] {
  const p = join(remoteDir(), "client-profiles.json");
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, "utf-8")) as RemoteClientProfileV1[];
  if (!Array.isArray(raw)) throw new Error("client-profiles.json: must be an array");
  const seen = new Set<string>();
  for (const c of raw) {
    if (!c.name || !c.url || !c.peerId || !c.signingKeyPath || !c.serverCertSha256) {
      throw new Error(`client-profiles.json: invalid entry for name=${c.name ?? "?"}`);
    }
    if (!c.url.startsWith("wss://")) throw new Error(`client-profiles.json: url must start with wss://`);
    if (!existsSync(c.signingKeyPath)) throw new Error(`client-profiles.json: signing key not found: ${c.signingKeyPath}`);
    if (seen.has(c.name)) throw new Error(`client-profiles.json: duplicate name: ${c.name}`);
    seen.add(c.name);
  }
  return raw;
}

function abmindHome(): string {
  return process.env.ABMIND_HOME ?? join(process.env.HOME ?? "/tmp", ".abmind");
}
