// Pins the unified-search ranking rule (Destin, 2026-07-22): no toggle — name
// matches render first, and a file that already name-matched never repeats in
// the content section.
import { describe, it, expect } from 'vitest';
import { dedupeContentHits, groupContentHits } from '../src/renderer/utils/content-search-ranking';

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
  it('groups by file in first-seen order, tolerating interleaved input', () => {
    const groups = groupContentHits([
      { path: 'CLAUDE.md', line: 3, text: 'a' },
      { path: 'ROADMAP.md', line: 8, text: 'b' },
      { path: 'CLAUDE.md', line: 12, text: 'c' },
    ]);
    expect(groups.map((g) => g.path)).toEqual(['CLAUDE.md', 'ROADMAP.md']);
    expect(groups[0].hits.map((h) => h.line)).toEqual([3, 12]);
    expect(groups[1].hits).toHaveLength(1);
  });
});
