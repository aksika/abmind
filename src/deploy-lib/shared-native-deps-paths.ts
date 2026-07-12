import { homedir } from "node:os";
import { join } from "node:path";

const LOCK_DIR_NAME = ".native-deps.lock";
const STAGING_DIR_NAME = ".native-deps-staging";
const MANIFEST_FILE = "native-deps.manifest.json";
const OWNER_FILE = "owner.json";

export { LOCK_DIR_NAME, STAGING_DIR_NAME, MANIFEST_FILE, OWNER_FILE };

function sharedRoot(): string {
  return process.env["AB_SHARED_DEPS_ROOT"] ?? join(homedir(), ".local", "lib");
}

export function resolveSharedNativeRoot(): string {
  return join(sharedRoot(), "node_modules");
}

export function lockDirPath(): string {
  return join(sharedRoot(), LOCK_DIR_NAME);
}

export function manifestFilePath(): string {
  return join(sharedRoot(), MANIFEST_FILE);
}

export function stagingDirPath(): string {
  return join(sharedRoot(), STAGING_DIR_NAME);
}

export function packageLivePath(pkgName: string): string {
  return join(resolveSharedNativeRoot(), pkgName);
}

export function packageStagingPath(opId: string, pkgName: string): string {
  return join(stagingDirPath(), opId, pkgName);
}
