import { describe, it, expect } from 'vitest';
import {
  buildChromeClipPath,
  chromeEdgeFalloff,
  type ChromeRect,
} from '../src/renderer/components/theme-effects-mask';

describe('buildChromeClipPath', () => {
  const viewport = { width: 1280, height: 720 };

  it('returns "none" when there are no rects (no clip applied)', () => {
    expect(buildChromeClipPath(viewport, [])).toBe('none');
  });

  it('produces an SVG path with the viewport outer rect plus one hole', () => {
    const rects: ChromeRect[] = [{ left: 0, top: 0, width: 1280, height: 40 }];
    const result = buildChromeClipPath(viewport, rects);
    expect(result.startsWith("path(evenodd, '")).toBe(true);
    expect(result).toContain('M 0 0 H 1280 V 720 H 0 Z');
    expect(result).toContain('M 0 0 H 1280 V 40 H 0 Z');
    expect(result.endsWith("')")).toBe(true);
  });

  it('emits a hole subpath for every rect, separated by spaces', () => {
    const rects: ChromeRect[] = [
      { left: 0, top: 0, width: 1280, height: 40 },
      { left: 0, top: 680, width: 1280, height: 40 },
    ];
    const result = buildChromeClipPath(viewport, rects);
    expect(result).toContain('M 0 0 H 1280 V 40 H 0 Z');
    expect(result).toContain('M 0 680 H 1280 V 720 H 0 Z');
  });
});

describe('chromeEdgeFalloff', () => {
  const FADE = 24;
  const rect: ChromeRect = { left: 100, top: 100, width: 200, height: 50 };

  it('returns 1 when there are no rects', () => {
    expect(chromeEdgeFalloff(50, 50, [], FADE)).toBe(1);
  });

  it('returns 1 for a particle far outside every rect', () => {
    expect(chromeEdgeFalloff(50, 50, [rect], FADE)).toBe(1);
  });

  it('returns 0 for a particle inside or on the boundary of a rect', () => {
    expect(chromeEdgeFalloff(150, 120, [rect], FADE)).toBe(0);
  });

  it('returns a smooth fraction within the fade band outside the rect', () => {
    // Particle 12px above the rect's top edge (rect top = 100, so y = 88 is 12px above)
    const m = chromeEdgeFalloff(150, 88, [rect], FADE);
    expect(m).toBeGreaterThan(0);
    expect(m).toBeLessThan(1);
    // 12 / 24 = 0.5
    expect(m).toBeCloseTo(0.5, 2);
  });

  it('uses the minimum (closest) rect when several rects are nearby', () => {
    const rectA: ChromeRect = { left: 100, top: 100, width: 100, height: 50 };
    const rectB: ChromeRect = { left: 100, top: 200, width: 100, height: 50 };
    // Particle at (150, 180) — 30px below A (well outside fade), 20px above B (inside fade band)
    const m = chromeEdgeFalloff(150, 180, [rectA, rectB], FADE);
    expect(m).toBeCloseTo(20 / 24, 2);
  });
});
