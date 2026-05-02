import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Phase 4 dispatcher smoke: invoke the built dist/cli/abmind.js binary and
 * verify lifecycle subcommands are listed in --help output. A full
 * functional test of install/update/rollback runs in a throwaway home
 * (not here — this is just dispatcher plumbing).
 *
 * Test runs from the repo root via vitest. cwd is the repo root so the
 * dispatcher finds abmind/package.json via createRequire.
 */
describe('abmind dispatcher — lifecycle subcommands', () => {
  it('--help lists lifecycle + memory subcommands', () => {
    const r = spawnSync('node', ['dist/cli/abmind.js', '--help'], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    const out = r.stdout;
    expect(out).toMatch(/install/);
    expect(out).toMatch(/update/);
    expect(out).toMatch(/rollback/);
    expect(out).toMatch(/status/);
    expect(out).toMatch(/recall/);
  });

  it('unknown subcommand exits 1', () => {
    const r = spawnSync('node', ['dist/cli/abmind.js', 'nonsense'], { encoding: 'utf-8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Unknown subcommand/);
  });

  it('status on uninitialized home reports not installed', async () => {
    const { mkdtemp, mkdir, rm } = await import('node:fs/promises');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const base = join(homedir(), '.cache', 'abmind-test');
    await mkdir(base, { recursive: true });
    const emptyHome = await mkdtemp(join(base, 'status-empty-'));
    try {
      const r = spawnSync('node', ['dist/cli/abmind.js', 'status'], {
        encoding: 'utf-8',
        env: { ...process.env, ABMIND_HOME: emptyHome },
      });
      // The runtime status script exits 1 when manifest missing.
      expect(r.stdout + r.stderr).toMatch(/not installed/);
      expect(r.status).toBe(1);
    } finally {
      await rm(emptyHome, { recursive: true, force: true });
    }
  });
});

