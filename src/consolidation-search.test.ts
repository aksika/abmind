import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLatestConsolidationFile, searchConsolidationFiles } from './consolidation-search.js';

// #1809: writer-produced calendar-date names must be discoverable alongside
// historical ISO-week/quarter names; unparseable names stay invisible.
describe('consolidation-search filename compatibility', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'consolidation-search-'));
    mkdirSync(join(root, 'daily'), { recursive: true });
    mkdirSync(join(root, 'weekly'), { recursive: true });
    mkdirSync(join(root, 'quarterly'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('discovers writer-produced date names and historical week names', () => {
    writeFileSync(join(root, 'weekly', 'weekly_2026-09-20.md'), 'fresh consolidation');
    writeFileSync(join(root, 'weekly', 'weekly_2026-W25.md'), 'older consolidation');
    writeFileSync(join(root, 'weekly', 'weekly_probe.md'), 'unparseable name');

    const latest = getLatestConsolidationFile(root, 'weekly');
    expect(latest?.filePath).toBe(join(root, 'weekly', 'weekly_2026-09-20.md'));

    const hits = searchConsolidationFiles(root, ['consolidation']);
    expect(hits.map(h => h.filePath).sort()).toEqual(
      [join(root, 'weekly', 'weekly_2026-09-20.md'), join(root, 'weekly', 'weekly_2026-W25.md')].sort(),
    );
  });

  it('discovers writer-produced quarterly date names and historical quarter names', () => {
    writeFileSync(join(root, 'quarterly', 'quarterly_2026-09-20.md'), 'fresh quarterly');
    writeFileSync(join(root, 'quarterly', 'quarterly_2026-Q2.md'), 'older quarterly');

    const latest = getLatestConsolidationFile(root, 'quarterly');
    expect(latest?.filePath).toBe(join(root, 'quarterly', 'quarterly_2026-09-20.md'));
  });

  it('returns null when only unparseable names exist', () => {
    writeFileSync(join(root, 'weekly', 'weekly_probe.md'), 'no date');
    expect(getLatestConsolidationFile(root, 'weekly')).toBeNull();
  });
});
