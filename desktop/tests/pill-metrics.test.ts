import { describe, it, expect } from 'vitest';
import {
  runtimeBadgeLabel, expandedPillWidth, pillMetrics, PILL_CHROME_PX, BADGE_CHROME_PX,
} from '../src/renderer/components/header/pill-metrics';
import { LABEL_TAIL_PX, LABEL_SLACK_PX } from '../src/renderer/components/header/pill-label-style';

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
  it('is text plus its fade tail plus chrome when there is no badge', () => {
    // The tail is the room the label box keeps past the text so the fade mask
    // never lands on the last letter; the packer must reserve it too.
    expect(expandedPillWidth('abcd', null, measure)).toBe(4 * 6 + LABEL_TAIL_PX + LABEL_SLACK_PX + PILL_CHROME_PX);
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
    expect(expandedPillWidth('a', null, (t) => t.length * 6.4)).toBe(Math.ceil(6.4) + LABEL_TAIL_PX + LABEL_SLACK_PX + PILL_CHROME_PX);
  });
});

describe('pillMetrics', () => {
  it('reports the name and the badge separately, and the total the packer budgets', () => {
    // The label box opens to nameWidth (+ tail); the badge opens to badgeWidth
    // after it; the packer reserves the sum. One measurement, three consumers.
    const m = pillMetrics('abcd', 'YouCoded · Coder', measure);
    expect(m.nameWidth).toBe(24);
    expect(m.badgeWidth).toBe('YouCoded · Coder'.length * 6 + BADGE_CHROME_PX);
    expect(m.expandedWidth).toBe(24 + LABEL_TAIL_PX + LABEL_SLACK_PX + PILL_CHROME_PX + m.badgeWidth);
  });

  it('measures in the fonts it is handed — the UI font is a monospace, not the system font', () => {
    const seen: string[] = [];
    pillMetrics('abcd', 'YouCoded · Coder', (t, font) => { seen.push(font); return t.length * 6; },
      { name: '500 12px Cascadia Mono', badge: '400 9px Cascadia Mono' });
    expect(seen).toEqual(['500 12px Cascadia Mono', '400 9px Cascadia Mono']);
  });

  it('has a zero-width badge for a session with none', () => {
    expect(pillMetrics('abcd', null, measure).badgeWidth).toBe(0);
  });
});
