// desktop/tests/drawer-width.test.ts
import { describe, it, expect } from 'vitest';
import { clampDrawerWidth, DEFAULT_DRAWER_WIDTH, MIN_DRAWER_WIDTH } from '../src/renderer/state/drawer-width';

// Pins the resize guardrails from the 2026-07-16 spec: min 320px, max 60% of
// the window, non-finite input falls back to the 480px default, and the
// result is always an integer (CSS px).
describe('clampDrawerWidth', () => {
  it('passes through an in-range width, rounded to an integer', () => {
    expect(clampDrawerWidth(600.4, 1920)).toBe(600);
  });

  it('clamps below the 320px minimum up to the minimum', () => {
    expect(clampDrawerWidth(100, 1920)).toBe(MIN_DRAWER_WIDTH);
    expect(MIN_DRAWER_WIDTH).toBe(320);
  });

  it('clamps above 60% of the window width down to that ceiling', () => {
    expect(clampDrawerWidth(2000, 1920)).toBe(Math.floor(1920 * 0.6));
  });

  it('never lets the ceiling drop below the minimum on tiny windows', () => {
    // 60% of 400px = 240 < 320 — the min wins so the drawer stays usable.
    expect(clampDrawerWidth(999, 400)).toBe(MIN_DRAWER_WIDTH);
  });

  it('falls back to the 480px default for non-finite input (corrupt localStorage)', () => {
    expect(clampDrawerWidth(NaN, 1920)).toBe(DEFAULT_DRAWER_WIDTH);
    expect(clampDrawerWidth(Infinity, 1920)).toBe(DEFAULT_DRAWER_WIDTH); // Infinity is non-finite too
  });
});
