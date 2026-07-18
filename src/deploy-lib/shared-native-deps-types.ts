export const PROTOCOL_VERSION = 1;
export const PROTOCOL_HASH = "v1-20260712";

export type NativeConsumer = "abtars" | "abmind";

export interface LockOwner {
  protocolVersion: 1;
  token: string;
  product: NativeConsumer;
  operation: string;
  pid: number;
  hostname: string;
  processStartedAt?: number;
  acquiredAt: string;
}

export interface NativePackageRecord {
  version: string;
  nodeAbi: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  contentHash: string;
  installedAt: string;
  installedBy: NativeConsumer;
  consumers: NativeConsumer[];
  probe: string;
}

export interface SharedNativeManifest {
  protocolVersion: 1;
  generation: number;
  updatedAt: string;
  packages: Record<string, NativePackageRecord>;
}

export interface PackageRequest {
  name: string;
  version: string;
  nodeAbi: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  sourceDir: string;
  probeModule: string;
}

export type CompatibilityKind = "reuse" | "install" | "conflict";

export interface CompatibilityDecision {
  kind: CompatibilityKind;
  reason: string;
  record?: NativePackageRecord;
}
