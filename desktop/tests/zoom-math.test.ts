// Pure geometry for the artifact zoom. No DOM on purpose: jsdom reports every
// getBoundingClientRect as zeros, so any geometric claim tested through the DOM
// would be testing nothing. Everything that can be a plain function is one.
import { describe, it, expect } from 'vitest';
import {
  ZOOM_RUNGS, fitScale, ladderFor, stepScale, clampOffset, zoomAtPoint, pointInRect,
} from '../src/renderer/components/artifact-views/zoom/zoom-math';

const big = { containerW: 400, containerH: 300, contentW: 2000, contentH: 1000 };
const small = { containerW: 900, containerH: 600, contentW: 300, contentH: 200 };

describe('fitScale', () => {
  it('shrinks oversized content to the tighter axis', () => {
    expect(fitScale(big)).toBeCloseTo(0.2);           // 400/2000 = 0.2 beats 300/1000 = 0.3
  });
  it('never upscales content smaller than the container', () => {
    expect(fitScale(small)).toBe(1);
  });
  it('returns 1 for degenerate sizes instead of Infinity or NaN', () => {
    expect(fitScale({ containerW: 0, containerH: 0, contentW: 0, contentH: 0 })).toBe(1);
  });
});

describe('ladderFor', () => {
  it('drops rungs at or below fit', () => {
    expect(ladderFor(1)).toEqual([1.5, 2, 4, 8]);     // a small image starts fitted at 100%
  });
  it('keeps every rung above a small fit', () => {
    expect(ladderFor(0.05)).toEqual([...ZOOM_RUNGS]);
  });
  it('drops a rung too close to fit to be worth a press', () => {
    // fit 12% with a 12.5% rung would be a 4% change — the button would look
    // broken. The next real step is 25%.
    expect(ladderFor(0.12)[0]).toBe(0.25);
  });
  it('gives a big picture a first step that is not a leap', () => {
    // The reported complaint: from a 12% fit the first press used to land on
    // 50%, more than four times bigger.
    expect(ladderFor(0.12)[0] / 0.12).toBeLessThan(2.5);
  });
});

describe('stepScale', () => {
  it('steps up from fit to the first rung above it', () => {
    expect(stepScale(1, 1, 1)).toBe(1.5);
  });
  it('bottoms out at fit rather than below it', () => {
    expect(stepScale(1.5, 1, -1)).toBe(1);
    expect(stepScale(1, 1, -1)).toBe(1);
  });
  it('tops out at the last rung', () => {
    expect(stepScale(8, 0.2, 1)).toBe(8);
  });
  it('snaps an off-rung scale from a wheel gesture to the neighbouring rung', () => {
    expect(stepScale(1.7, 0.2, 1)).toBe(2);
    expect(stepScale(1.7, 0.2, -1)).toBe(1.5);
  });
  it('treats fit itself as a stop below the lowest reachable rung', () => {
    expect(stepScale(0.5, 0.2, -1)).toBe(0.25);        // the rung between
    expect(stepScale(0.25, 0.2, -1)).toBeCloseTo(0.2); // then fit
  });
});

describe('clampOffset', () => {
  it('pins content to zero offset when it is not larger than the container', () => {
    expect(clampOffset({ x: 50, y: 50 }, 0.2, big)).toEqual({ x: 0, y: 0 });
  });
  it('never lets content be dragged past its own edge', () => {
    // At scale 1 the content is 2000x1000 in a 400x300 box: 1600x700 of slack,
    // half of it on each side because the content is centred.
    expect(clampOffset({ x: 9999, y: -9999 }, 1, big)).toEqual({ x: 800, y: -350 });
  });
  it('leaves an in-range offset alone', () => {
    expect(clampOffset({ x: 100, y: -100 }, 1, big)).toEqual({ x: 100, y: -100 });
  });
});

describe('zoomAtPoint', () => {
  it('keeps the pixel under the pointer under the pointer', () => {
    // Zoom 1x -> 2x anchored on the container's bottom-right corner. The content
    // must move up and left, or the pixel under the cursor slides away.
    const next = zoomAtPoint({ scale: 1, offset: { x: 0, y: 0 } }, 2, { x: 400, y: 300 }, big);
    expect(next.scale).toBe(2);
    expect(next.offset.x).toBeLessThan(0);
    expect(next.offset.y).toBeLessThan(0);
  });
  it('is a no-op on the offset when anchored dead centre', () => {
    const next = zoomAtPoint({ scale: 1, offset: { x: 0, y: 0 } }, 2, { x: 200, y: 150 }, big);
    expect(next.offset).toEqual({ x: 0, y: 0 });
  });
  it('clamps the resulting offset', () => {
    const next = zoomAtPoint({ scale: 1, offset: { x: 0, y: 0 } }, 0.2, { x: 0, y: 0 }, big);
    expect(next.offset).toEqual({ x: 0, y: 0 });
  });
});

describe('pointInRect', () => {
  const r = { left: 10, top: 20, right: 110, bottom: 220 };
  it('accepts a point inside and on the edge', () => {
    expect(pointInRect(50, 100, r)).toBe(true);
    expect(pointInRect(10, 20, r)).toBe(true);
    expect(pointInRect(110, 220, r)).toBe(true);
  });
  it('rejects a point outside on every side', () => {
    expect(pointInRect(9, 100, r)).toBe(false);
    expect(pointInRect(111, 100, r)).toBe(false);
    expect(pointInRect(50, 19, r)).toBe(false);
    expect(pointInRect(50, 221, r)).toBe(false);
  });
});
