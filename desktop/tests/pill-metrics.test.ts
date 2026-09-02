import { describe, it, expect } from 'vitest';
import { expandedPillWidth, pillMetrics, PILL_CHROME_PX } from '../src/renderer/components/header/pill-metrics';
import { LABEL_TAIL_PX, LABEL_SLACK_PX } from '../src/renderer/components/header/pill-label-style';

// 6px per character, whatever the font — enough to assert the arithmetic.
const measure = (t: string) => t.length * 6;

describe('expandedPillWidth', () => {
  it('is text plus its fade tail and slack plus chrome', () => {
    // The tail is the room the label box keeps past the text so the fade mask
    // never lands on the last letter; the packer must reserve it too.
    expect(expandedPillWidth('abcd', measure)).toBe(4 * 6 + LABEL_TAIL_PX + LABEL_SLACK_PX + PILL_CHROME_PX);
  });

  it('rounds up, so a fractional text width never under-reserves', () => {
    expect(expandedPillWidth('a', (t) => t.length * 6.4)).toBe(Math.ceil(6.4) + LABEL_TAIL_PX + LABEL_SLACK_PX + PILL_CHROME_PX);
  });
});

describe('pillMetrics', () => {
  it('reports the name width the label opens to, and the total the packer budgets', () => {
    const m = pillMetrics('abcd', measure);
    expect(m.nameWidth).toBe(24);
    expect(m.expandedWidth).toBe(24 + LABEL_TAIL_PX + LABEL_SLACK_PX + PILL_CHROME_PX);
  });

  it('measures in the font it is handed — the UI font is a monospace, not the system font', () => {
    const seen: string[] = [];
    pillMetrics('abcd', (t, font) => { seen.push(font); return t.length * 6; }, '500 12px Cascadia Mono');
    expect(seen).toEqual(['500 12px Cascadia Mono']);
  });
});
