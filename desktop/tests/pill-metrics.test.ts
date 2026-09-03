import { describe, it, expect } from 'vitest';
import { expandedPillWidth, pillMetrics, PILL_CHROME_PX } from '../src/renderer/components/header/pill-metrics';
import { LABEL_TAIL_PX, LABEL_SLACK_PX, labelTargetWidth } from '../src/renderer/components/header/pill-label-style';

// 6px per character, whatever the font — enough to assert the arithmetic.
const measure = (t: string) => t.length * 6;

describe('expandedPillWidth', () => {
  it('is text plus its fade tail plus chrome — exactly what the pill renders at', () => {
    // The tail is the room the label box keeps past the text so the fade mask
    // never lands on the last letter; the packer must reserve it too.
    expect(expandedPillWidth('abcd', measure)).toBe(4 * 6 + LABEL_TAIL_PX + PILL_CHROME_PX);
  });

  it('is NOT rounded up and carries no slack — the label box max-width is a ceiling, not a size', () => {
    // Measured 2026-09-03: a 151.2px name renders a 191.2px pill (text + tail +
    // chrome) while the box's max-width sits at 166 (ceil + tail + slack). The
    // packer used to reserve the ceiling's arithmetic, 2-3px more than the
    // pill takes, and a drag judged against it parked every dot 2px off — all
    // of them nudged back on release ("they still bug out a little on release").
    expect(expandedPillWidth('a', (t) => t.length * 6.4)).toBe(6.4 + LABEL_TAIL_PX + PILL_CHROME_PX);
    const m = pillMetrics('a', (t) => t.length * 6.4);
    const boxCeiling = labelTargetWidth({ isActive: true, packExpanded: true, nameWidth: m.nameWidth });
    expect(boxCeiling).toBe(Math.ceil(6.4) + LABEL_TAIL_PX + LABEL_SLACK_PX);
    expect(boxCeiling).toBeGreaterThan(m.expandedWidth - PILL_CHROME_PX);   // the box never clips the name
  });
});

describe('pillMetrics', () => {
  it('reports the name width the label opens to, and the total the packer budgets', () => {
    const m = pillMetrics('abcd', measure);
    expect(m.nameWidth).toBe(24);
    expect(m.expandedWidth).toBe(24 + LABEL_TAIL_PX + PILL_CHROME_PX);
  });

  it('measures in the font it is handed — the UI font is a monospace, not the system font', () => {
    const seen: string[] = [];
    pillMetrics('abcd', (t, font) => { seen.push(font); return t.length * 6; }, '500 12px Cascadia Mono');
    expect(seen).toEqual(['500 12px Cascadia Mono']);
  });
});
