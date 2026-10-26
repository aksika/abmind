import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decodeGcFile,
  encodeGcFile,
  persistGcSelection,
  readGcMarks,
  withGcLock,
  writeGcMarks,
} from './gc-codec.js';

describe('sleep/gc-codec', () => {
  it('decodes the canonical map without touching timestamps', () => {
    const status = decodeGcFile({ '123': '2026-09-20T01:00:00.000Z', '45': '2026-09-19T01:00:00.000Z' });
    expect(status.kind).toBe('ok');
    if (status.kind !== 'ok') return;
    expect(status.marks.get(123)).toBe('2026-09-20T01:00:00.000Z');
    expect(status.marks.get(45)).toBe('2026-09-19T01:00:00.000Z');
  });

  it.each([[undefined], ['{}'], ['[]'], ['{"messages":[]}']])('accepts %s as empty state', (raw) => {
    const value = raw === undefined ? undefined : JSON.parse(raw);
    expect(decodeGcFile(value).kind).toBe('empty');
  });

  it('rejects nonempty alternate shapes without conversion', () => {
    const shapes: unknown[] = [
      [{ msg_id: 1 }],
      [{ messageId: 2 }],
      { messages: [{ messageId: 3 }] },
      { '01': '2026-09-20T01:00:00.000Z' },
      { '7': 'not-a-date' },
      [1, 2],
      'just a string',
      42,
    ];
    for (const raw of shapes) {
      expect(decodeGcFile(raw).kind).toBe('incompatible');
    }
  });

  it('round-trips through encode with stable key order', () => {
    const marks = new Map([[9, '2026-09-20T01:00:00.000Z'], [3, '2026-09-19T01:00:00.000Z']]);
    expect(encodeGcFile(marks)).toBe('{"3":"2026-09-19T01:00:00.000Z","9":"2026-09-20T01:00:00.000Z"}');
  });
});

describe('sleep/gc-codec persistence (#1807 R4)', () => {
  let dir: string;
  const diags: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gc-codec-'));
    diags.length = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const onIncompatible = (detail: string): void => { diags.push(detail); };

  it('persists a validated selection, preserving earlier timestamps', async () => {
    writeGcMarks(dir, new Map([[5, '2026-09-18T01:00:00.000Z']]));
    const outcome = await persistGcSelection(dir, 'noise: [5, 9]', new Set([5, 9]), Date.parse('2026-09-20T02:00:00.000Z'), onIncompatible);
    expect(outcome).toEqual({ ok: true, ids: [5, 9] });
    const status = readGcMarks(dir);
    expect(status.kind).toBe('ok');
    if (status.kind !== 'ok') return;
    expect(status.marks.get(5)).toBe('2026-09-18T01:00:00.000Z');
    expect(status.marks.get(9)).toBe('2026-09-20T02:00:00.000Z');
  });

  it('rejects out-of-set IDs without writing anything', async () => {
    const outcome = await persistGcSelection(dir, '[404]', new Set([1, 2]), Date.now(), onIncompatible);
    expect(outcome.ok).toBe(false);
    expect(readGcMarks(dir).kind).toBe('empty');
  });

  it('fails closed on an incompatible file, leaving it untouched', async () => {
    writeFileSync(join(dir, 'garbage.json'), JSON.stringify([{ msg_id: 1 }]));
    const outcome = await persistGcSelection(dir, '[1]', new Set([1]), Date.now(), onIncompatible);
    expect(outcome.ok).toBe(false);
    expect(diags.length).toBe(1);
    expect(readGcMarks(dir).kind).toBe('incompatible');
  });

  it('serializes concurrent mutations without lost updates', async () => {
    const a = withGcLock(dir, () => { writeGcMarks(dir, new Map([[1, '2026-09-20T01:00:00.000Z']])); });
    const b = withGcLock(dir, () => {
      const status = readGcMarks(dir);
      const marks = status.kind === 'ok' ? status.marks : new Map();
      marks.set(2, '2026-09-20T01:00:00.000Z');
      writeGcMarks(dir, marks);
    });
    await Promise.all([a, b]);
    const status = readGcMarks(dir);
    expect(status.kind).toBe('ok');
    if (status.kind !== 'ok') return;
    expect([...status.marks.keys()].sort()).toEqual([1, 2]);
  });
});
