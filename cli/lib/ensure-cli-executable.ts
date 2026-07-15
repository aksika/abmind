/**
 * ensure-cli-executable.ts — resolve and repair the abmind CLI global binary.
 *
 * Uses `npm prefix -g` to locate the global bin directory (modern npm removed
 * `npm bin -g`; `npm prefix -g` still works on npm 10/11). Provides a shared
 * check and a shared repair used by both `abmind update` (fatal after install)
 * and `abmind doctor` (diagnostic + --fix).
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync, lstatSync, chmodSync, readlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

export interface CliBinaryStatus {
  readonly binPath: string;
  readonly exists: boolean;
  readonly isExecutable: boolean;
  readonly message: string;
}

/**
 * Resolve the global abmind binary path using `npm prefix -g`.
 * On Unix convention: <prefix>/bin/abmind.
 * Throws if the npm command itself fails.
 */
export function resolveAbmindBinPath(): string {
  const r = spawnSync("npm", ["prefix", "-g"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) {
    const stderr = r.stderr?.trim() ?? "";
    throw new Error(`npm prefix -g failed (exit ${r.status}): ${stderr || "unknown error"}`);
  }
  const prefix = r.stdout.trim();
  if (!prefix) throw new Error("npm prefix -g returned empty output");
  return join(prefix, "bin", "abmind");
}

/**
 * Check the abmind CLI binary status. Never throws — returns a status object.
 * Follows symlinks to verify the actual target's executable bit.
 */
export function checkAbmindBinary(): CliBinaryStatus {
  let binPath: string;
  try {
    binPath = resolveAbmindBinPath();
  } catch (err) {
    return {
      binPath: "unknown",
      exists: false,
      isExecutable: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // existsSync follows symlinks; a broken symlink's target doesn't exist,
  // so we fall back to lstatSync to detect the broken symlink case.
  let pathExists = existsSync(binPath);
  if (!pathExists) {
    try { pathExists = lstatSync(binPath).isSymbolicLink(); } catch { /* neither file nor symlink */ }
  }
  if (!pathExists) {
    return { binPath, exists: false, isExecutable: false, message: `not found at ${binPath}` };
  }

  // Follow symlink to check the actual target
  let targetPath = binPath;
  try {
    const st = lstatSync(binPath);
    if (st.isSymbolicLink()) {
      const linkTarget = readlinkSync(binPath);
      targetPath = resolve(dirname(binPath), linkTarget);
      if (!existsSync(targetPath)) {
        return { binPath, exists: true, isExecutable: false, message: `symlink target missing: ${targetPath}` };
      }
    }
  } catch (err) {
    return { binPath, exists: true, isExecutable: false, message: `cannot stat: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    const mode = statSync(targetPath).mode & 0o111;
    const executable = mode !== 0;
    return {
      binPath,
      exists: true,
      isExecutable: executable,
      message: executable ? `executable at ${binPath}` : `not executable at ${binPath} (target: ${targetPath})`,
    };
  } catch (err) {
    return { binPath, exists: true, isExecutable: false, message: `cannot stat target: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Ensure the abmind CLI binary is executable. Throws if the binary is missing,
 * the symlink target is missing, or chmod fails.
 */
export function ensureAbmindExecutable(): void {
  const status = checkAbmindBinary();
  if (!status.exists) {
    throw new Error(status.message);
  }
  if (status.isExecutable) return;

  // Determine the actual file to chmod (follow symlinks)
  let targetPath = status.binPath;
  try {
    const st = lstatSync(status.binPath);
    if (st.isSymbolicLink()) {
      targetPath = resolve(dirname(status.binPath), readlinkSync(status.binPath));
      if (!existsSync(targetPath)) {
        throw new Error(`abmind CLI symlink target missing: ${targetPath}`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("symlink target missing")) throw err;
    throw new Error(`cannot resolve abmind CLI binary: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    chmodSync(targetPath, 0o755);
  } catch (err) {
    throw new Error(`cannot chmod +x abmind CLI at ${targetPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
