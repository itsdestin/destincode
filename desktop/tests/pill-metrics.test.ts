import { describe, it, expect } from 'vitest';
import {
  runtimeBadgeLabel, expandedPillWidth, PILL_CHROME_PX, BADGE_CHROME_PX,
} from '../src/renderer/components/header/pill-metrics';

// 6px per character, whatever the font — enough to assert the arithmetic.
const measure = (t: string) => t.length * 6;

describe('runtimeBadgeLabel', () => {
  it('is null for a Claude Code session — no badge, no width', () => {
    expect(runtimeBadgeLabel('claude', undefined)).toBeNull();
  });

  it('names the preset for a native session', () => {
    expect(runtimeBadgeLabel('native', 'coder')).toBe('YouCoded · Coder');
    expect(runtimeBadgeLabel('native', 'assistant')).toBe('YouCoded · Assistant');
  });
});

describe('expandedPillWidth', () => {
  it('is text plus chrome when there is no badge', () => {
    expect(expandedPillWidth('abcd', null, measure)).toBe(4 * 6 + PILL_CHROME_PX);
  });

  it('INCLUDES the badge — the 2026-08-31 truncation bug', () => {
    // The packer used to measure only the name, so it expanded native pills the
    // strip had no room for. The name then ellipsised while the badge kept its
    // full width beside it.
    const badge = 'YouCoded · Coder';
    const withBadge = expandedPillWidth('abcd', badge, measure);
    const without = expandedPillWidth('abcd', null, measure);
    expect(withBadge - without).toBe(badge.length * 6 + BADGE_CHROME_PX);
    expect(withBadge).toBeGreaterThan(without + 90);   // ~96px in the real font
  });

  it('rounds up, so a fractional text width never under-reserves', () => {
    expect(expandedPillWidth('a', null, (t) => t.length * 6.4)).toBe(Math.ceil(6.4) + PILL_CHROME_PX);
  });
});
