#!/usr/bin/env node
// Suppress logger stderr output during status display
const _origErr = console.error;
console.error = () => {};
/**
 * abmind status-runtime — print runtime state (lock, key, SOUL, memory, sleep, hooks).
 *
 * #863: the release slot is gone. Version is read from the global install's
 * package.json (via getPackageVersion), not from the manifest. The `current`
 * symlink check is removed. The manifest is still read for install-time
 * metadata (commit, branch, source, activatedAt, host) but those fields
 * are no longer maintained by `abmind update`.
 *
 * Named status-runtime to avoid collision with the renamed memory-stats
 * command. Dispatcher exposes it as `abmind status`.
 */

import { inspectLock, packagePaths, readManifest } from '../src/deploy-lib/index.js';
import { getPackageVersion } from './banner.js';
import { printBanner } from './banner.js';
import { loadMemoryConfig } from '../src/memory-config.js';
import { MemoryManager } from '../src/memory-manager.js';
import { initializeDatabase } from '../src/memory-db.js';
import { join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';

async function run(): Promise<number> {
  const paths = packagePaths('abmind');
  const manifest = await readManifest(paths.manifest);
  await printBanner("status");
  const lock = await inspectLock(paths.lock);

  if (!manifest) {
    process.stdout.write(
      `abmind: not installed (no manifest at ${paths.manifest})\n` +
        `Run 'abmind install' to set up.\n`,
    );
    return 1;
  }

  const lines = [
    `abmind status`,
    `  home:          ${paths.home}`,
    `  version:       ${getPackageVersion()}`,
  ];

  // Only show commit/branch if known
  if (manifest.commit && manifest.commit !== '(unknown)') lines.push(`  commit:        ${manifest.commit}`);
  if (manifest.branch && manifest.branch !== '(unknown)') lines.push(`  branch:        ${manifest.branch}`);

  lines.push(`  source:        ${manifest.source}`);
  lines.push(`  activated:     ${manifest.activatedAt}`);
  lines.push(`  host:          ${manifest.host}`);

  // Key, SOUL, embedding status
  const { statSync, readFileSync: readFs } = await import('node:fs');
  const keyPath = join(paths.home, 'secret', 'abmind.key');
  lines.push(`  key:           ${existsSync(keyPath) ? '✓ abmind.key' : '✗ missing'}`);

  const soulPath = join(paths.home, 'memory', 'core', 'SOUL.md');
  if (existsSync(soulPath)) {
    const size = (statSync(soulPath).size / 1024).toFixed(1);
    lines.push(`  SOUL:          ✓ (${size} KB)`);
  } else {
    lines.push(`  SOUL:          ✗ missing`);
  }

  // Embedding model from env
  const embModel = process.env['EMBEDDING_MODEL'] ?? 'nomic-embed-text';
  const embProvider = process.env['EMBEDDING_PROVIDER'] ?? 'ollama';
  lines.push(`  embedding:     ${embModel} (${embProvider})`);
  if (lock.held) {
    lines.push(
      `  lock:          HELD by pid ${lock.content.pid} (${lock.content.cmd})${lock.stale ? ' — STALE' : ''}`,
    );
  } else {
    lines.push(`  lock:          not held`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);

  // Memory stats
  try {
    const config = loadMemoryConfig();
    const memory = new MemoryManager(config);
    await memory.initialize({ skipEmbeddingCheck: true });
    const stats = memory.getStats();
    if (stats) {
      const dbMb = (stats.dbSizeBytes / 1024 / 1024).toFixed(1);
      const types = Object.entries(stats.extractedByType).map(([t, n]) => `    ${t}: ${n}`).join('\n');
      process.stdout.write([
        '',
        '  ── Memory ──',
        `  messages:      ${stats.totalMessages}`,
        `  memories:      ${stats.extractedMemories}`,
        types ? `  by type:\n${types}` : '',
        `  consolidation: daily=${stats.consolidationFiles.daily} weekly=${stats.consolidationFiles.weekly} quarterly=${stats.consolidationFiles.quarterly}`,
        `  DB size:       ${dbMb} MB`,
      ].filter(Boolean).join('\n') + '\n');
    }
    memory.close();
     // restore
  } catch { /* memory not initialized yet — skip */ }

  // Sleep state
  try {
    const config = loadMemoryConfig();
    const dbPath = join(config.memoryDir, 'memory.db');
    if (existsSync(dbPath)) {
      const db = initializeDatabase(dbPath);
      const sleepDir = join(config.memoryDir, 'sleep');
      const audits = existsSync(sleepDir) ? readdirSync(sleepDir).filter(f => f.endsWith('.md')).length : 0;
      const locks = existsSync(sleepDir) ? readdirSync(sleepDir).filter(f => f.endsWith('.lock')).length : 0;
      process.stdout.write([
        '',
        '  ── Sleep ──',
        `  audits:        ${audits}`,
        `  active locks:  ${locks}`,
      ].join('\n') + '\n');
      db.close();
      
    }
  } catch { /* sleep data not available — skip */ }

  // Hook status (#344)
  try {
    const { hookErrorLogPath, abmindHooksDir } = await import('../src/mem-paths.js');
    const errLog = hookErrorLogPath();
    const dir = abmindHooksDir();
    let errorCount = 0;
    let lastError: string | null = null;
    if (existsSync(errLog)) {
      const { readFileSync } = await import('node:fs');
      const lines = readFileSync(errLog, 'utf-8').trim().split('\n').filter(Boolean);
      errorCount = lines.length;
      lastError = lines[lines.length - 1] ?? null;
    }
    const sidecars = existsSync(dir)
      ? readdirSync(dir).filter(f => f.startsWith('last-prompt-')).length
      : 0;
    if (errorCount > 0 || sidecars > 0) {
      const lines2 = ['', '  ── Hooks (#344) ──'];
      if (errorCount > 0) {
        lines2.push(`  errors:        ${errorCount} total`);
        if (lastError) lines2.push(`  last error:    ${lastError.slice(0, 100)}`);
        lines2.push(`                 run 'abmind hook-doctor' for details`);
      }
      if (sidecars > 0) lines2.push(`  active sidecars: ${sidecars}`);
      process.stdout.write(lines2.join('\n') + '\n');
    }
  } catch { /* hooks paths unavailable — skip */ }

  return 0;
}

try {
  const exitCode = await run();
  process.exit(exitCode);
} catch (err) {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
