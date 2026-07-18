import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

/** Recursively list non-test TypeScript files under a directory. */
function listTs(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === 'node_modules' || e === 'dist') continue;
      listTs(p, acc);
    } else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * #1430 Task 7: a reintroduced npm-global runtime path must not slip back in.
 * These strings are how abmind used to own its CLI via `npm install -g`; the
 * standalone model removes them from all supported lifecycle code.
 */
const FORBIDDEN = ['npm install -g', 'npm prefix -g', 'npm root -g'];

describe('standalone packaging guard (#1430)', () => {
  it('package.json ships no public bin.abmind mapping', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    expect(pkg.bin ?? {}).toEqual({});
  });

  it('lifecycle code (cli/ + src/) contains no npm-global runtime lookup', () => {
    const files = [...listTs(join(root, 'cli')), ...listTs(join(root, 'src'))];
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf-8');
      for (const needle of FORBIDDEN) {
        if (text.includes(needle)) offenders.push(`${f}: "${needle}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
