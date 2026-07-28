// Pure geometry for the traced selection outline (spec 2026-07-26 §5.6).
// getClientRects() on a multi-line selection returns ONE RECT PER LINE BOX;
// the outline is the stepped union of those boxes — down the right edges,
// back up the left. No DOM needed, so this runs in the default node env.
import { describe, it, expect } from 'vitest';
import { buildUnionPath, buildRoundedOutlinePath, mergeAdjacentBoxes, toBoxes, shiftPath, type Box } from './reference-geometry';

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

  // Restoration fix: real browsers hand back sub-pixel DOMRect values; the
  // old (deleted) outline carried those through unrounded, which was a
  // direct source of visible jitter. This is currently unproven — the
  // pre-restoration `toBoxes` had no rounding step at all — and fails
  // against it (0.5 offsets flow straight through to the output).
  it('snaps every edge to a whole pixel', () => {
    const out = toBoxes([rect(120.4, 70.6, 40.2, 20.3)], host, 0);
    // left = 120.4 - 100 = 20.4 -> 20; top = 70.6 - 50 = 20.6 -> 21;
    // right = 120.4+40.2 - 100 = 60.6 -> 61; bottom = 70.6+20.3 - 50 = 40.9 -> 41
    expect(out).toEqual([box(20, 21, 61, 41)]);
  });

  it('drops near-zero (not just exactly-zero) rects — collapsed-range measurement noise', () => {
    // width 0.4 is sub-pixel noise, not a real line box (real text line
    // boxes are never sub-pixel tall/wide).
    expect(toBoxes([rect(120, 70, 0.4, 20)], host, 0)).toHaveLength(0);
  });
});

describe('mergeAdjacentBoxes', () => {
  it('passes through arrays too short to merge unchanged', () => {
    expect(mergeAdjacentBoxes([])).toEqual([]);
    expect(mergeAdjacentBoxes([box(0, 0, 10, 10)])).toEqual([box(0, 0, 10, 10)]);
  });

  // This is currently unproven — the pre-restoration geometry had no merge
  // pass at all, so two adjacent boxes 1px apart on both edges are returned
  // untouched, not snapped to a shared edge — and fails against it.
  it('snaps left/right edges within tolerance to a shared value on adjacent boxes', () => {
    const boxes = [box(10, 0, 90, 20), box(11, 20, 89, 40)];
    const out = mergeAdjacentBoxes(boxes, 2);
    expect(out[0].l).toBe(out[1].l);
    expect(out[0].r).toBe(out[1].r);
    // Merged to the min left / max right — the union grows to cover both,
    // never shrinks below either box's own extent.
    expect(out[0].l).toBe(10);
    expect(out[0].r).toBe(90);
  });

  it('leaves edges alone when the difference exceeds tolerance (a real content difference, not noise)', () => {
    const boxes = [box(10, 0, 90, 20), box(30, 20, 90, 40)]; // 20px apart — a real mid-line start
    const out = mergeAdjacentBoxes(boxes, 2);
    expect(out[0].l).toBe(10);
    expect(out[1].l).toBe(30);
  });

  it('does not mutate its input', () => {
    const boxes = [box(10, 0, 90, 20), box(11, 20, 89, 40)];
    const snapshot = boxes.map((b) => ({ ...b }));
    mergeAdjacentBoxes(boxes, 2);
    expect(boxes).toEqual(snapshot);
  });
});

describe('buildRoundedOutlinePath', () => {
  it('returns empty string for no boxes', () => {
    expect(buildRoundedOutlinePath([])).toBe('');
  });

  // Hand-derived: box(0,0,4,20) has a 4px-wide top/bottom edge, so the
  // default radius (6) must clamp to half that edge (2px) at every corner —
  // this is the "clamped to half the shorter adjacent edge" requirement.
  // This is currently unproven — buildRoundedOutlinePath does not exist yet
  // on the pre-restoration code — and fails simply because the import
  // doesn't resolve.
  it('rounds a single narrow box, clamping the radius to half the short edge', () => {
    const d = buildRoundedOutlinePath([box(0, 0, 4, 20)], 6);
    expect(d).toBe('M 2 0 Q 4 0 4 2 L 4 18 Q 4 20 2 20 L 2 20 Q 0 20 0 18 L 0 2 Q 0 0 2 0 Z');
    // Contains a curve command — the whole point of "rounded".
    expect(d).toContain('Q');
  });

  // Hand-derived two-box stepped case (mirrors buildUnionPath's 3-line test
  // in spirit): a wide top line, a narrower bottom line. Several corners here
  // clamp to 5 (half of the 10px step) instead of the full default radius 6,
  // proving the clamp is genuinely per-vertex, not a single global value.
  it('rounds every corner of a multi-line stepped union, clamping per-vertex', () => {
    const d = buildRoundedOutlinePath([box(0, 0, 20, 20), box(0, 20, 10, 40)], 6);
    expect(d).toBe(
      'M 14 0 Q 20 0 20 6 L 20 15 Q 20 20 15 20 L 15 20 Q 10 20 10 25 ' +
      'L 10 35 Q 10 40 5 40 L 5 40 Q 0 40 0 35 L 0 26 Q 0 20 0 14 L 0 6 Q 0 0 6 0 Z',
    );
  });

  it('closes the path', () => {
    expect(buildRoundedOutlinePath([box(0, 0, 10, 10)]).endsWith('Z')).toBe(true);
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

  // The rounded outline path (buildRoundedOutlinePath) emits Q commands —
  // shiftPath must shift BOTH coordinate pairs a Q carries (control point,
  // then endpoint), not just the first. This is currently unproven — the
  // pre-restoration regex only matched `[ML]`, so a `Q` command would pass
  // through completely unshifted — and fails against it.
  it('shifts both coordinate pairs of a Q (quadratic curve) command', () => {
    const d = buildRoundedOutlinePath([box(0, 0, 4, 20)], 6);
    const shifted = shiftPath(d, 10, 5);
    expect(shifted).toBe('M 12 5 Q 14 5 14 7 L 14 23 Q 14 25 12 25 L 12 25 Q 10 25 10 23 L 10 7 Q 10 5 12 5 Z');
  });
});
