import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, basename } from "node:path";
import { stagingDirPath, packageLivePath, packageStagingPath } from "./shared-native-deps-paths.js";
import type { NativeConsumer, NativePackageRecord, PackageRequest } from "./shared-native-deps-types.js";
import { readManifest, writeManifest, upsertRecord } from "./shared-native-deps-manifest.js";

export function hashDirectory(dir: string): string {
  const hash = createHash("sha256");
  hash.update(`dir:${dir}`);
  const entries = readdirSync(dir, { recursive: true }).sort() as string[];
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const stat = readdirSync.length > 0 ? undefined : undefined;
      const content = readFileSync(full);
      hash.update(`${entry}:${content.length}:`);
      hash.update(content);
    } catch {
      // skip
    }
  }
  return hash.digest("hex").slice(0, 16);
}

export function probePackage(nodeExec: string, modulePath: string, probeModule: string): boolean {
  try {
    const code = `require(${JSON.stringify(join(modulePath, probeModule))}); console.log("ok");`;
    const result = execSync(`"${nodeExec}" -e ${JSON.stringify(code)}`, {
      cwd: modulePath,
      timeout: 10000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_PATH: "" },
    });
    return result.trim() === "ok";
  } catch {
    return false;
  }
}

export function stagePackage(sourceDir: string, pkgName: string): string {
  const opId = `op_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const staging = packageStagingPath(opId, pkgName);
  mkdirSync(staging, { recursive: true });

  // Copy source dir contents into staging
  execSync(`cp -R "${sourceDir}/." "${staging}/"`, { stdio: "ignore", timeout: 30000 });

  // Write operation marker
  writeFileSync(join(stagingDirPath(), opId + ".marker"), JSON.stringify({
    opId,
    pkgName,
    createdAt: new Date().toISOString(),
  }) + "\n");

  return opId;
}

export interface ActivateResult {
  record: NativePackageRecord;
  previousDeleted: boolean;
}

export function activatePackage(
  opId: string,
  pkgName: string,
  request: PackageRequest,
  hash: string,
  probeResult: string,
): ActivateResult {
  const live = packageLivePath(pkgName);
  const staged = packageStagingPath(opId, pkgName);
  const prev = live + ".prev." + opId;

  // Step 1: Rename live to prev (if exists)
  if (existsSync(live)) {
    renameSync(live, prev);
  }

  // Step 2: Rename staged to live
  renameSync(staged, live);

  // Step 3: Read and update manifest
  const manifest = readManifest() ?? { protocolVersion: 1 as const, generation: 0, updatedAt: new Date().toISOString(), packages: {} };

  const record: NativePackageRecord = {
    version: request.version,
    nodeAbi: request.nodeAbi,
    nodeVersion: request.nodeVersion,
    platform: request.platform,
    arch: request.arch,
    contentHash: hash,
    installedAt: new Date().toISOString(),
    installedBy: request.sourceDir.includes("abtars") ? "abtars" as NativeConsumer : "abmind" as NativeConsumer,
    consumers: [],
    probe: probeResult,
  };

  const updated = upsertRecord(manifest, pkgName, record);
  writeManifest(updated);

  // Step 4: Delete prev
  const prevExists = existsSync(prev);
  if (prevExists) {
    rmSync(prev, { recursive: true, force: true });
  }

  return { record, previousDeleted: prevExists };
}

export function rollbackActivation(opId: string, pkgName: string): void {
  const live = packageLivePath(pkgName);
  const prev = live + ".prev." + opId;
  const staged = packageStagingPath(opId, pkgName);

  // Restore prev → live
  if (existsSync(prev) && !existsSync(live)) {
    renameSync(prev, live);
  }

  // Clean up staging
  if (existsSync(staged)) {
    rmSync(stagingDirPath(), { recursive: true, force: true });
  }
}
