// Pins the unified-search ranking rule (Destin, 2026-07-22): no toggle — name
// matches render first, and a file that already name-matched never repeats in
// the content section.
import { describe, it, expect } from 'vitest';
import { dedupeContentHits } from '../src/renderer/utils/content-search-ranking';

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
