import { writeFileSync, renameSync, openSync, fsyncSync, closeSync, unlinkSync } from "node:fs";

/** Atomic write: .tmp → fsync → rename. Crash-safe on POSIX. */
export function atomicWriteSync(path: string, data: string): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, data, "utf-8");
  const fd = openSync(tmp, "r");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, path);
}

/** Clean orphan .tmp files left by crashes. Call on boot. */
export function cleanOrphanTmp(path: string): void {
  try { unlinkSync(path + ".tmp"); } catch { /* no orphan */ }
}
