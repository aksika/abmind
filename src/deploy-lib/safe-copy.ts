/**
 * Safe recursive copy that skips non-regular-file entries Node's cp()
 * refuses to handle (EINVAL on sockets). Real runtime roots can contain
 * UNIX sockets (browser.sock, memory.sock, etc.) which are ephemeral IPC
 * endpoints — not data we want or can back up.
 *
 * Skipped: sockets, FIFOs, block devices, character devices.
 * Copied:  regular files, directories, symlinks.
 */

import { cp, lstat } from 'node:fs/promises';

export interface SafeCopyOptions {
  readonly preserveTimestamps?: boolean;
  /** Overwrite existing entries at the destination. Default: false. */
  readonly force?: boolean;
}

async function shouldCopy(src: string): Promise<boolean> {
  try {
    const s = await lstat(src);
    if (s.isSocket() || s.isFIFO() || s.isBlockDevice() || s.isCharacterDevice()) {
      return false;
    }
    return true;
  } catch {
    // Let the subsequent cp call surface the real error if any.
    return true;
  }
}

export async function safeCopyTree(src: string, dst: string, opts: SafeCopyOptions = {}): Promise<void> {
  await cp(src, dst, {
    recursive: true,
    preserveTimestamps: opts.preserveTimestamps === true,
    force: opts.force === true,
    filter: shouldCopy,
  });
}
