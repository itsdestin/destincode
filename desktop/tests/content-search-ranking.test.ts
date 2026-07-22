// Pins the unified-search ranking rule (Destin, 2026-07-22): no toggle — name
// matches render first, and a file that already name-matched never repeats in
// the content section.
import { describe, it, expect } from 'vitest';
import { dedupeContentHits, groupContentHits, capGroups } from '../src/renderer/utils/content-search-ranking';

describe('dedupeContentHits', () => {
  it('drops hits for files already shown as name matches', () => {
    const hits = [
      { path: 'src/timeout.ts', line: 3, text: 'x' },
      { path: 'src/server.ts', line: 9, text: 'y' },
    ];
    expect(dedupeContentHits(hits, new Set(['src/timeout.ts']))).toEqual([
      { path: 'src/server.ts', line: 9, text: 'y' },
    ]);
  });
});

describe('groupContentHits', () => {
  it('groups by file and sorts by match count, most first; ties keep first-seen order', () => {
    const groups = groupContentHits([
      { path: 'ROADMAP.md', line: 8, text: 'b' },
      { path: 'CLAUDE.md', line: 3, text: 'a' },
      { path: 'CLAUDE.md', line: 12, text: 'c' },
      { path: 'notes.md', line: 1, text: 'd' },
    ]);
    expect(groups.map((g) => g.path)).toEqual(['CLAUDE.md', 'ROADMAP.md', 'notes.md']);
    expect(groups[0].hits.map((h) => h.line)).toEqual([3, 12]);
  });
});

describe('capGroups', () => {
  const mk = (path: string, n: number) => ({ path, hits: Array.from({ length: n }, (_, i) => ({ path, line: i + 1, text: 'x' })) });
  it('keeps whole groups within the budget and reports the cut', () => {
    const { groups, shownRows, capped } = capGroups([mk('a', 3), mk('b', 3), mk('c', 3)], 7);
    expect(groups.map((g) => g.path)).toEqual(['a', 'b']);
    expect(shownRows).toBe(6);
    expect(capped).toBe(true);
  });
  it('always shows the first group, clipped, when it alone exceeds the budget', () => {
    const { groups, shownRows, capped } = capGroups([mk('big', 100), mk('b', 2)], 10);
    expect(groups[0].hits).toHaveLength(10);
    expect(shownRows).toBe(10);
    expect(capped).toBe(true);
  });
  it('no cap when everything fits', () => {
    const { shownRows, capped } = capGroups([mk('a', 2), mk('b', 2)], 60);
    expect(shownRows).toBe(4);
    expect(capped).toBe(false);
  });
});
