import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectSkillDuplicates, formatDedupCandidates } from './skill-dedup.js';

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
