// Pure geometry for the traced selection outline (spec 2026-07-26 §5.6).
// getClientRects() on a multi-line selection returns ONE RECT PER LINE BOX;
// the outline is the stepped union of those boxes — down the right edges,
// back up the left. No DOM needed, so this runs in the default node env.
import { describe, it, expect } from 'vitest';
import { buildUnionPath, toBoxes, shiftPath, type Box } from './reference-geometry';

const box = (l: number, t: number, r: number, b: number): Box => ({ l, t, r, b });

describe('buildUnionPath', () => {
  it('returns empty string for no boxes', () => {
    expect(buildUnionPath([])).toBe('');
  });

  it('traces a single line box as a closed rectangle', () => {
    expect(buildUnionPath([box(10, 0, 90, 20)])).toBe(
      'M 90 0 L 90 20 L 10 20 L 10 0 Z',
    );
  });

  it('steps down the right edges then back up the left', () => {
    // Classic 3-line selection: starts mid-line, full middle, ends mid-line.
    const d = buildUnionPath([box(40, 0, 100, 20), box(0, 20, 100, 40), box(0, 40, 60, 60)]);
    expect(d).toBe(
      'M 100 0 L 100 20 L 100 20 L 100 40 L 60 40 L 60 60 ' +
      'L 0 60 L 0 40 L 0 40 L 0 20 L 40 20 L 40 0 Z',
    );
  });

  it('closes the path', () => {
    expect(buildUnionPath([box(0, 0, 10, 10)]).endsWith('Z')).toBe(true);
  });
});

describe('toBoxes', () => {
  const host = { left: 100, top: 50 } as DOMRect;
  const rect = (l: number, t: number, w: number, h: number) =>
    ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h }) as DOMRect;

  it('converts to host-relative coordinates', () => {
    expect(toBoxes([rect(120, 70, 40, 20)], host, 0)).toEqual([box(20, 20, 60, 40)]);
  });

  it('applies padding outward on all four sides', () => {
    expect(toBoxes([rect(120, 70, 40, 20)], host, 2)).toEqual([box(18, 18, 62, 42)]);
  });

  it('drops zero-area rects (collapsed ranges produce them)', () => {
    expect(toBoxes([rect(120, 70, 0, 20), rect(120, 90, 40, 20)], host, 0)).toHaveLength(1);
  });

  it('sorts by top so unsorted input still steps downward', () => {
    const out = toBoxes([rect(120, 90, 40, 20), rect(120, 70, 40, 20)], host, 0);
    expect(out[0].t).toBeLessThan(out[1].t);
  });
});

// Task 8: clip-path correction. clip-path: path() resolves against the
// clipped element's OWN border box, not the viewport, so a viewport-relative
// `d` must be re-expressed relative to the clone's own rect before use.
describe('shiftPath', () => {
  it('shifts every M/L coordinate pair by (dx, dy)', () => {
    const d = buildUnionPath([box(10, 0, 90, 20)]); // 'M 90 0 L 90 20 L 10 20 L 10 0 Z'
    expect(shiftPath(d, -10, -5)).toBe('M 80 -5 L 80 15 L 0 15 L 0 -5 Z');
  });

  it('leaves a multi-box union path fully shifted, command-by-command', () => {
    const d = buildUnionPath([box(40, 0, 100, 20), box(0, 20, 100, 40)]);
    expect(shiftPath(d, 5, 5)).toBe(
      'M 105 5 L 105 25 L 105 25 L 105 45 L 5 45 L 5 25 L 45 25 L 45 5 Z',
    );
  });

  it('passes an empty path through unchanged', () => {
    expect(shiftPath('', -10, -5)).toBe('');
  });

  it('is a no-op with a zero offset', () => {
    const d = buildUnionPath([box(0, 0, 10, 10)]);
    expect(shiftPath(d, 0, 0)).toBe(d);
  });
});
