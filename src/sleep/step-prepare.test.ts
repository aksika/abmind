import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  consolidationInputs,
  knowledgeAvailabilitySection,
  knowledgeFileInputs,
  prepareStepDispatch,
  previousConsolidationSection,
  RETRO_ABSENT_MARKER,
  scanTemplateVars,
} from './step-prepare.js';

describe('sleep/step-prepare rendering (#1807 R1)', () => {
  it('scans referenced variables in first-seen order', () => {
    expect(scanTemplateVars('a ${ONE} b ${TWO} c ${ONE}')).toEqual(['ONE', 'TWO']);
  });

  it('renders single-pass: inserted data is never rescanned', () => {
    const out = prepareStepDispatch('s', 'path: ${P}', { P: 'value with ${Q} inside' });
    expect(out).toEqual({ status: 'ready', prompt: 'path: value with ${Q} inside' });
  });

  it('fails preparation on unbound references without dispatch', () => {
    const out = prepareStepDispatch('retro-derive', 'read ${AGENT_NOTES_PATH} and ${MISSING}', {
      AGENT_NOTES_PATH: '/x',
    });
    expect(out.status).toBe('preparation_failed');
    if (out.status !== 'preparation_failed') return;
    expect(out.detail).toContain('retro-derive');
    expect(out.detail).toContain('MISSING');
  });

  it('retro absent marker is an explicit skip signal, not prose data', () => {
    expect(RETRO_ABSENT_MARKER.startsWith('ABSENT')).toBe(true);
  });
});

describe('sleep/step-prepare knowledge inputs (#1807 R2)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'step-prepare-'));
    mkdirSync(join(dir, 'core'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('binds absolute paths and reports missing files as skippable', () => {
    writeFileSync(join(dir, 'core', 'agent_notes.md'), 'notes');
    const files = knowledgeFileInputs(dir);
    expect(files.find(f => f.name === 'agent_notes.md')).toMatchObject({
      path: join(dir, 'core', 'agent_notes.md'),
      exists: true,
      readable: true,
    });
    expect(files.find(f => f.name === 'user_profile.md')?.exists).toBe(false);
    const { section, unreadable } = knowledgeAvailabilitySection(files);
    expect(unreadable).toEqual([]);
    expect(section).toContain(join(dir, 'core', 'agent_notes.md'));
    expect(section).toContain('ABSENT');
  });
});

describe('sleep/step-prepare consolidation inputs (#1807 R3)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'step-prepare-cons-'));
    mkdirSync(join(dir, 'daily'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('selects exactly the seven inclusive dates with explicit gaps', () => {
    writeFileSync(join(dir, 'daily', 'daily_2026-09-18.md'), 'a');
    writeFileSync(join(dir, 'daily', 'daily_2026-09-20.md'), 'b');
    writeFileSync(join(dir, 'daily', 'notes.txt'), 'ignored: wrong extension');
    writeFileSync(join(dir, 'daily', 'daily_2026-09-20.bak'), 'ignored: wrong suffix');
    const sel = consolidationInputs(dir, new Date('2026-09-20T12:00:00'), false);
    expect(sel.selected.map(s => s.date)).toEqual(['2026-09-18', '2026-09-20']);
    expect(sel.selected.every(s => s.path.startsWith(dir))).toBe(true);
    expect(sel.missingDates).toHaveLength(5);
    expect(sel.coveredRange).toContain('2026-09-14');
    expect(sel.coveredRange).toContain('2026-09-20');
  });

  it('selects stamped files by heading period (#1821)', () => {
    const stamped = join(dir, 'daily', 'daily_2026-09-19-0002Z.md');
    writeFileSync(stamped, '# Daily Summary 2026-09-18 — 2026-09-19\nrange');
    const sel = consolidationInputs(dir, new Date('2026-09-20T12:00:00'), false);
    expect(sel.selected.length).toBeGreaterThan(0);
    expect(sel.selected.every(s => s.path === stamped)).toBe(true);
    expect(new Set(sel.selected.map(s => s.date))).toEqual(new Set(['2026-09-18', '2026-09-19']));
  });

  it('prefers the newest file on overlap (#1821)', () => {
    writeFileSync(join(dir, 'daily', 'daily_2026-09-18.md'), '# Daily Summary 2026-09-18\nlegacy');
    const stamped = join(dir, 'daily', 'daily_2026-09-19-0002Z.md');
    writeFileSync(stamped, '# Daily Summary 2026-09-18 — 2026-09-19\nrange');
    const sel = consolidationInputs(dir, new Date('2026-09-20T12:00:00'), false);
    const hit = sel.selected.find(s => s.date === '2026-09-18');
    expect(hit?.path).toBe(stamped);
  });

  it('quarterly covers the previous complete quarter only', () => {
    writeFileSync(join(dir, 'daily', 'daily_2026-06-30.md'), 'q2 end');
    writeFileSync(join(dir, 'daily', 'daily_2026-07-01.md'), 'q3 start');
    writeFileSync(join(dir, 'daily', 'daily_2026-09-20.md'), 'today');
    const sel = consolidationInputs(dir, new Date('2026-09-20T12:00:00'), true);
    expect(sel.selected.map(s => s.date)).toEqual(['2026-06-30']);
    expect(sel.missingDates).not.toContain('2026-09-20');
  });

  it('previous consolidation distinguishes path from absence', () => {
    expect(previousConsolidationSection('/x/weekly_2026-09-20.md')).toContain('/x/weekly_2026-09-20.md');
    const absent = previousConsolidationSection(null);
    expect(absent).toContain('ABSENT');
    expect(absent).not.toContain('No consolidation files yet.');
  });

  it('roots containing spaces flow through as data, not shell fragments', () => {
    const spaced = mkdtempSync(join(tmpdir(), 'step prepare spaced root '));
    try {
      mkdirSync(join(spaced, 'core'), { recursive: true });
      mkdirSync(join(spaced, 'daily'), { recursive: true });
      writeFileSync(join(spaced, 'core', 'agent_notes.md'), 'notes');
      writeFileSync(join(spaced, 'daily', 'daily_2026-09-20.md'), 'daily');
      const files = knowledgeFileInputs(spaced);
      expect(files.find(f => f.name === 'agent_notes.md')?.path).toBe(join(spaced, 'core', 'agent_notes.md'));
      const sel = consolidationInputs(spaced, new Date('2026-09-20T12:00:00'), false);
      expect(sel.selected.map(s => s.path)).toEqual([join(spaced, 'daily', 'daily_2026-09-20.md')]);
      const rendered = prepareStepDispatch('retro-derive', 'read ${AGENT_NOTES_PATH}', {
        AGENT_NOTES_PATH: files[0]!.path,
      });
      expect(rendered).toEqual({ status: 'ready', prompt: `read ${join(spaced, 'core', 'agent_notes.md')}` });
    } finally {
      rmSync(spaced, { recursive: true, force: true });
    }
  });
});
