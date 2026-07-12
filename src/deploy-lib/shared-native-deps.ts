import { generateLockToken, acquireLock, releaseLock, LockError } from "./shared-native-deps-lock.js";
import { readManifest, createEmptyManifest, writeManifest, resolveCompatibility, addConsumer } from "./shared-native-deps-manifest.js";
import { stagePackage, hashDirectory, probePackage, activatePackage, rollbackActivation } from "./shared-native-deps-activate.js";
import { packageLivePath, packageStagingPath } from "./shared-native-deps-paths.js";
import type { NativeConsumer, PackageRequest, NativePackageRecord } from "./shared-native-deps-types.js";
import { existsSync } from "node:fs";

export interface EnsureResult {
  action: "reused" | "installed";
  record: NativePackageRecord;
}

export class NativeDepsError extends Error {
  constructor(msg: string) { super(msg); this.name = "NativeDepsError"; }
}

export function ensureSharedDependency(
  product: NativeConsumer,
  request: PackageRequest,
  nodeExec: string,
): EnsureResult {
  const token = generateLockToken();
  acquireLock(product, `install:${request.name}`, token);

  try {
    const manifest = readManifest() ?? createEmptyManifest();
    const diskExists = existsSync(packageLivePath(request.name));
    const decision = resolveCompatibility(request, manifest, diskExists);

    if (decision.kind === "conflict") {
      throw new NativeDepsError(decision.reason);
    }

    if (decision.kind === "reuse" && decision.record) {
      const updated = addConsumer(manifest, request.name, product);
      writeManifest(updated);
      return { action: "reused", record: decision.record };
    }

    // Install path
    const opId = stagePackage(request.sourceDir, request.name);
    const hash = hashDirectory(packageStagingPath(opId, request.name));

    const probeOk = probePackage(nodeExec, packageStagingPath(opId, request.name), request.probeModule);
    const probeLabel = probeOk ? `probe:${request.probeModule}=ok` : `probe:${request.probeModule}=fail`;

    try {
      const { record: nativeRecord } = activatePackage(opId, request.name, request, hash, probeLabel);
      // Add consumer after activation
      const afterManifest = readManifest();
      if (afterManifest) {
        const withConsumer = addConsumer(afterManifest, request.name, product);
        writeManifest(withConsumer);
      }
      return { action: "installed", record: nativeRecord };
    } catch (err) {
      rollbackActivation(opId, request.name);
      throw new NativeDepsError(`Activation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    releaseLock(token);
  }
}

export * from "./shared-native-deps-types.js";
export * from "./shared-native-deps-lock.js";
export * from "./shared-native-deps-manifest.js";
export * from "./shared-native-deps-activate.js";
export * from "./shared-native-deps-paths.js";
