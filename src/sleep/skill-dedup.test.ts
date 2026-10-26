import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectSkillDuplicates, formatDedupCandidates, resolveSkillCatalog, SKILL_CATALOG_UNAVAILABLE } from './skill-dedup.js';

describe('sleep/skill-dedup', () => {
  let tmp: string;
  let coreDir: string;
  let selfDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'skill-dedup-'));
    coreDir = join(tmp, 'core');
    selfDir = join(tmp, 'self');
    mkdirSync(coreDir, { recursive: true });
    mkdirSync(selfDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns empty for no self skills', () => {
    mkdirSync(join(coreDir, 'tools', 'gmail'), { recursive: true });
    expect(detectSkillDuplicates(coreDir, selfDir)).toEqual([]);
  });

  it('detects core overlap by root word', () => {
    mkdirSync(join(coreDir, 'tools', 'gmail'), { recursive: true });
    mkdirSync(join(selfDir, 'gmail-check'));
    mkdirSync(join(selfDir, 'gmail-read'));

    const candidates = detectSkillDuplicates(coreDir, selfDir);
    const overlaps = candidates.filter(c => c.reason === 'core-overlap');
    expect(overlaps.length).toBe(2);
    expect(overlaps.every(c => c.coreMatch === 'gmail')).toBe(true);
  });

  it('detects fragmentation without core overlap', () => {
    mkdirSync(join(selfDir, 'twitter-check'));
    mkdirSync(join(selfDir, 'twitter-post'));

    const candidates = detectSkillDuplicates(coreDir, selfDir);
    const frags = candidates.filter(c => c.reason === 'fragmentation');
    expect(frags.length).toBe(2);
    expect(frags[0]!.siblings).toContain('twitter-post');
  });

  it('does not double-report core-overlap skills as fragmentation', () => {
    mkdirSync(join(coreDir, 'tools', 'gmail'), { recursive: true });
    mkdirSync(join(selfDir, 'gmail-check'));
    mkdirSync(join(selfDir, 'gmail-read'));

    const candidates = detectSkillDuplicates(coreDir, selfDir);
    // Both flagged as core-overlap, not fragmentation
    expect(candidates.every(c => c.reason === 'core-overlap')).toBe(true);
  });

  it('ignores self skills that do not match any core domain', () => {
    mkdirSync(join(coreDir, 'tools', 'gmail'), { recursive: true });
    mkdirSync(join(selfDir, 'weather-forecast'));

    const candidates = detectSkillDuplicates(coreDir, selfDir);
    expect(candidates).toEqual([]);
  });

  it('returns empty for missing directories', () => {
    expect(detectSkillDuplicates('/nonexistent', '/also-nonexistent')).toEqual([]);
  });

  it('formatDedupCandidates produces readable text', () => {
    const text = formatDedupCandidates([
      { selfSkill: 'gmail-check', reason: 'core-overlap', coreMatch: 'gmail' },
      { selfSkill: 'twitter-post', reason: 'fragmentation', siblings: ['twitter-read'] },
    ]);
    expect(text).toContain('self/gmail-check');
    expect(text).toContain('overlaps core');
    expect(text).toContain('fragmented');
  });

  it('formatDedupCandidates returns empty string for no candidates', () => {
    expect(formatDedupCandidates([])).toBe('');
  });
});

describe('sleep/skill-dedup catalog resolution (#1810)', () => {
  it('resolves explicit host-supplied directories when both exist', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-catalog-'));
    try {
      const core = join(tmp, 'core');
      const self = join(tmp, 'self');
      mkdirSync(core, { recursive: true });
      mkdirSync(self, { recursive: true });
      expect(resolveSkillCatalog({ core, self })).toEqual({
        state: 'ready',
        coreSkillsDir: core,
        selfSkillsDir: self,
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports unavailable when explicit directories are missing', () => {
    expect(resolveSkillCatalog({ core: '/nonexistent', self: '/also-nonexistent' })).toEqual({
      state: 'unavailable',
    });
  });

  it('reports unavailable when the default home has no skill directories', () => {
    const origHome = process.env.HOME;
    const origAbtars = process.env.ABTARS_HOME;
    const tmp = mkdtempSync(join(tmpdir(), 'skill-catalog-empty-'));
    try {
      delete process.env.ABTARS_HOME;
      process.env.HOME = tmp;
      expect(resolveSkillCatalog()).toEqual({ state: 'unavailable' });
    } finally {
      if (origAbtars === undefined) delete process.env.ABTARS_HOME;
      else process.env.ABTARS_HOME = origAbtars;
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('unavailable marker states absence, not a clean bill of health', () => {
    expect(SKILL_CATALOG_UNAVAILABLE).toContain('unavailable');
    expect(SKILL_CATALOG_UNAVAILABLE.toLowerCase()).not.toContain('no skill duplicates');
  });
});
