import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packagePaths, resolveAbmindHome, resolveAbtarsHome, resolveUserBinDir } from './paths.js';

describe('deploy-lib/paths', () => {
  const originalBridge = process.env['ABTARS_HOME'];
  const originalAbmind = process.env['ABMIND_HOME'];

  afterEach(() => {
    if (originalBridge === undefined) delete process.env['ABTARS_HOME'];
    else process.env['ABTARS_HOME'] = originalBridge;
    if (originalAbmind === undefined) delete process.env['ABMIND_HOME'];
    else process.env['ABMIND_HOME'] = originalAbmind;
  });

  it('resolveAbtarsHome defaults to ~/.abtars', () => {
    delete process.env['ABTARS_HOME'];
    expect(resolveAbtarsHome()).toBe(join(homedir(), '.abtars'));
  });

  it('resolveAbtarsHome honors ABTARS_HOME override', () => {
    process.env['ABTARS_HOME'] = '/custom/bridge';
    expect(resolveAbtarsHome()).toBe('/custom/bridge');
  });

  it('resolveAbmindHome honors ABMIND_HOME override', () => {
    process.env['ABMIND_HOME'] = '/custom/abmind';
    expect(resolveAbmindHome()).toBe('/custom/abmind');
  });

  it('resolveUserBinDir is always ~/.local/bin', () => {
    expect(resolveUserBinDir()).toBe(join(homedir(), '.local', 'bin'));
  });

  it('packagePaths composes all sub-paths under home', () => {
    process.env['ABTARS_HOME'] = '/x/ab';
    const p = packagePaths('abtars');
    expect(p.home).toBe('/x/ab');
    expect(p.config).toBe('/x/ab/config');
    expect(p.releases).toBe('/x/ab/releases');
    expect(p.current).toBe('/x/ab/current');
    expect(p.nodeModules).toBe('/x/ab/node_modules');
    expect(p.bin).toBe('/x/ab/bin');
    expect(p.manifest).toBe('/x/ab/manifest.json');
    expect(p.lock).toBe('/x/ab/.update.lock');
  });
});
