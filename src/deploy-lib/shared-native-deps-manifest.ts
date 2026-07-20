import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { manifestFilePath } from "./shared-native-deps-paths.js";
import type { SharedNativeManifest, NativePackageRecord, NativeConsumer, PackageRequest, CompatibilityDecision } from "./shared-native-deps-types.js";
import { PROTOCOL_VERSION } from "./shared-native-deps-types.js";

export function readManifest(): SharedNativeManifest | null {
  try {
    const raw = readFileSync(manifestFilePath(), "utf-8");
    const m = JSON.parse(raw) as SharedNativeManifest;
    if (m.protocolVersion !== PROTOCOL_VERSION) return null;
    return m;
  } catch {
    return null;
  }
}

export function readManifestRaw(): string | null {
  try {
    return readFileSync(manifestFilePath(), "utf-8");
  } catch {
    return null;
  }
}

export function createEmptyManifest(): SharedNativeManifest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    generation: 0,
    updatedAt: new Date().toISOString(),
    packages: {},
  };
}

export function writeManifest(m: SharedNativeManifest): void {
  const p = manifestFilePath();
  mkdirSync(dirname(p), { recursive: true });
  // Atomic write: write to tmp, then rename
  const tmp = p + ".tmp." + process.pid;
  writeFileSync(tmp, JSON.stringify(m, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, p);
}

export function resolveCompatibility(
  request: PackageRequest,
  manifest: SharedNativeManifest,
  diskExists: boolean,
): CompatibilityDecision {
  const existing = manifest.packages[request.name];

  if (!existing) {
    if (diskExists) {
      return { kind: "conflict", reason: `Package ${request.name} exists on disk but is untracked in manifest` };
    }
    return { kind: "install", reason: "new package" };
  }

  // Check consumer compatibility
  if (existing.nodeAbi !== request.nodeAbi) {
    return {
      kind: "conflict",
      reason: `Node ABI mismatch: installed ${existing.nodeAbi}, requested ${request.nodeAbi} — ${existing.consumers.join("/")} require ${existing.nodeAbi}`,
    };
  }

  if (existing.platform !== request.platform) {
    return { kind: "conflict", reason: `Platform mismatch: installed ${existing.platform}, requested ${request.platform}` };
  }

  if (existing.arch !== request.arch) {
    return { kind: "conflict", reason: `Arch mismatch: installed ${existing.arch}, requested ${request.arch}` };
  }

  // Version check — allow same or newer
  if (existing.version === request.version) {
    return { kind: "reuse", reason: "already installed at requested version", record: existing };
  }

  // Different version — check if all consumers can accept it
  // For now, only add consumer if compatible
  return { kind: "install", reason: `version change: ${existing.version} → ${request.version}`, record: existing };
}

export function addConsumer(
  manifest: SharedNativeManifest,
  pkgName: string,
  consumer: NativeConsumer,
): SharedNativeManifest {
  const rec = manifest.packages[pkgName];
  if (!rec) return manifest;
  const set = new Set(rec.consumers);
  set.add(consumer);
  return {
    ...manifest,
    packages: {
      ...manifest.packages,
      [pkgName]: { ...rec, consumers: [...set].sort() },
    },
    generation: manifest.generation + 1,
    updatedAt: new Date().toISOString(),
  };
}

export function removeConsumer(
  manifest: SharedNativeManifest,
  pkgName: string,
  consumer: NativeConsumer,
): { manifest: SharedNativeManifest; canDelete: boolean } {
  const rec = manifest.packages[pkgName];
  if (!rec) return { manifest, canDelete: false };
  const set = new Set(rec.consumers);
  set.delete(consumer);
  const consumers = [...set].sort();
  if (consumers.length === 0) {
    const { [pkgName]: _, ...rest } = manifest.packages;
    return {
      manifest: { ...manifest, packages: rest, generation: manifest.generation + 1, updatedAt: new Date().toISOString() },
      canDelete: true,
    };
  }
  return {
    manifest: {
      ...manifest,
      packages: { ...manifest.packages, [pkgName]: { ...rec, consumers } },
      generation: manifest.generation + 1,
      updatedAt: new Date().toISOString(),
    },
    canDelete: false,
  };
}

export function upsertRecord(
  manifest: SharedNativeManifest,
  pkgName: string,
  record: NativePackageRecord,
): SharedNativeManifest {
  return {
    ...manifest,
    packages: { ...manifest.packages, [pkgName]: record },
    generation: manifest.generation + 1,
    updatedAt: new Date().toISOString(),
  };
}

export function upsertRecordGroup(
  manifest: SharedNativeManifest,
  records: ReadonlyMap<string, NativePackageRecord>,
  now: string,
): SharedNativeManifest {
  const merged = { ...manifest.packages };
  for (const [name, record] of records) {
    merged[name] = record;
  }
  return {
    ...manifest,
    packages: merged,
    generation: manifest.generation + 1,
    updatedAt: now,
  };
}
