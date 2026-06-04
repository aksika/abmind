import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isUnsafeRemovalTarget, planRemoval, removePath } from './cleanup.js';

describe('deploy-lib/cleanup', () => {
  describe('isUnsafeRemovalTarget', () => {
    it.each([
      ['empty', ''],
      ['whitespace', '   '],
      ['tilde', '~'],
      ['root slash', '/'],
      ['root backslash', '\\'],
      ['home itself', homedir()],
      ['outside home', '/etc/passwd'],
      ['outside home 2', '/tmp'],
    ])('rejects %s', (_name, path) => {
      expect(isUnsafeRemovalTarget(path)).toBe(true);
    });

    it('accepts a path under home', () => {
      expect(isUnsafeRemovalTarget(join(homedir(), '.abtars', 'config'))).toBe(false);
    });
  });

  describe('removePath', () => {
    // Must use $HOME-rooted tmpdir — system /tmp is deliberately unsafe.
    let tmp: string;
    beforeEach(async () => {
      const base = join(homedir(), '.cache', 'abmind-test');
      await mkdir(base, { recursive: true });
      tmp = await mkdtemp(join(base, 'deploy-lib-cleanup-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it('throws on unsafe target', async () => {
      await expect(removePath('/')).rejects.toThrow(/unsafe/);
    });

    it('dry-run reports would-remove without touching disk', async () => {
      const target = join(tmp, 'child');
      const { writeFile, mkdir: mkdirP } = await import('node:fs/promises');
      await mkdirP(target);
      await writeFile(join(target, 'f'), 'x');
      const result = await removePath(target, { dryRun: true });
      expect(result).toBe(true);
      const { stat } = await import('node:fs/promises');
      await expect(stat(target)).resolves.toBeDefined();
    });

    it('removes existing path', async () => {
      const target = join(tmp, 'child');
      const { mkdir: mkdirP } = await import('node:fs/promises');
      await mkdirP(target);
      const result = await removePath(target);
      expect(result).toBe(true);
    });

    it('returns false (not throws) on missing path', async () => {
      const result = await removePath(join(tmp, 'does-not-exist'));
      expect(result).toBe(false);
    });
  });

  describe('planRemoval', () => {
    it('refuses unsafe targets without removing', () => {
      const plan = planRemoval('/');
      expect(plan.willRemove).toBe(false);
      expect(plan.reason).toMatch(/unsafe/);
    });

    it('plans removal of safe targets', () => {
      const plan = planRemoval(join(homedir(), '.abtars'));
      expect(plan.willRemove).toBe(true);
    });
  });
});
