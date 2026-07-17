import { describe, it, expect } from 'vitest';
import {
  BAR_CONTENT, BAR_PADDING, BAR_GAP_PX, CHAT_SIZE, CHAT_GAP_PX, MASCOT_SIZE,
  computeBarContentRect, computeBarPosition, computeGroupLayout,
} from '../src/main/buddy-bar-geometry';

const wa = { x: 0, y: 0, width: 1920, height: 1080 };
const mascot = (x: number, y: number) => ({ x, y, width: 112, height: 112 });

/** Destin's actual workspace: a 2880×1800 panel at 200% scale, minus taskbar.
 *  Short enough that the chat cannot always fit above or below the mascot. */
const SHORT_WA = { x: 0, y: 0, width: 1440, height: 852 };

const rectsOverlap = (
  a: { x: number; y: number }, aSize: { width: number; height: number },
  b: { x: number; y: number }, bSize: { width: number; height: number },
) => a.x < b.x + bSize.width && a.x + aSize.width > b.x
  && a.y < b.y + bSize.height && a.y + aSize.height > b.y;

describe('computeBarContentRect', () => {
  it('sits to the right of the mascot, centered on his hands (not his midline)', () => {
    const r = computeBarContentRect(mascot(500, 300), wa);
    expect(r.x).toBe(500 + 112 + BAR_GAP_PX);
    // Hands sit at 58.3% of the mascot's height, below the 50% midline.
    const handsY = 300 + Math.round(112 * 0.583);
    expect(r.y).toBe(handsY - BAR_CONTENT.height / 2);
    expect(handsY).toBeGreaterThan(300 + 56); // strictly below center
  });

  it('flips to the left when the right side would clip the workArea', () => {
    const r = computeBarContentRect(mascot(1820, 300), wa);
    expect(r.x).toBe(1820 - BAR_CONTENT.width - BAR_GAP_PX);
  });

  it('leaves room for the window padding when deciding to flip', () => {
    // Content alone would fit on the right, but content+padding would not.
    const x = wa.width - 112 - BAR_GAP_PX - BAR_CONTENT.width - (BAR_PADDING - 2);
    const r = computeBarContentRect(mascot(x, 300), wa);
    expect(r.x).toBeLessThan(x); // flipped left
  });
});

describe('computeBarPosition', () => {
  it('is the content rect grown by BAR_PADDING', () => {
    const c = computeBarContentRect(mascot(500, 300), wa);
    expect(computeBarPosition(mascot(500, 300), wa)).toEqual({
      x: c.x - BAR_PADDING,
      y: c.y - BAR_PADDING,
    });
  });

  it('clamps the window (not just the row) at the top edge', () => {
    expect(computeBarPosition(mascot(500, -40), wa).y).toBe(0);
  });

  it('handles non-zero workArea origin (secondary monitor)', () => {
    const wa2 = { x: 1920, y: 0, width: 1920, height: 1080 };
    const r = computeBarContentRect(mascot(1920 + 1920 - 112, 300), wa2);
    expect(r.x).toBe(1920 + 1920 - 112 - BAR_CONTENT.width - BAR_GAP_PX);
  });
});

describe('computeGroupLayout', () => {
  it('hangs the chat below the mascot when there is room, leaving him put', () => {
    const l = computeGroupLayout(mascot(600, 100), wa);
    expect(l.chat.y).toBe(100 + 112 + CHAT_GAP_PX);
    expect(l.mascot).toEqual({ x: 600, y: 100 });
  });

  it('flips the chat above when it would not fit below, leaving him put', () => {
    const l = computeGroupLayout(mascot(600, 900), wa);
    expect(l.chat.y).toBe(900 - CHAT_SIZE.height - CHAT_GAP_PX);
    expect(l.mascot).toEqual({ x: 600, y: 900 });
  });

  // The 2026-07-16 regression: on Destin's short workArea the mascot sat at
  // y=370, where neither slot fits. Clamping put the chat at y=0 — right on top
  // of a mascot spanning 370..482 — so the buddy could not be clicked to close
  // the chat he had just opened.
  it('never lets the chat cover the mascot, anywhere on a short workArea', () => {
    for (let y = 0; y <= SHORT_WA.height - MASCOT_SIZE.height; y += 1) {
      const l = computeGroupLayout(mascot(700, y), SHORT_WA);
      expect(
        rectsOverlap(l.chat, CHAT_SIZE, l.mascot, MASCOT_SIZE),
        `mascot y=${y} → mascot ${l.mascot.y}, chat ${l.chat.y}`,
      ).toBe(false);
    }
  });

  it('keeps both windows fully on screen, anywhere on a short workArea', () => {
    const inside = (p: { x: number; y: number }, s: { width: number; height: number }) =>
      p.x >= SHORT_WA.x && p.y >= SHORT_WA.y
      && p.x + s.width <= SHORT_WA.x + SHORT_WA.width
      && p.y + s.height <= SHORT_WA.y + SHORT_WA.height;
    for (let y = 0; y <= SHORT_WA.height - MASCOT_SIZE.height; y += 1) {
      const l = computeGroupLayout(mascot(700, y), SHORT_WA);
      expect(inside(l.chat, CHAT_SIZE), `chat, mascot y=${y}`).toBe(true);
      expect(inside(l.mascot, MASCOT_SIZE), `mascot, mascot y=${y}`).toBe(true);
    }
  });

  it('holds the pinned gap exactly when it has to push the mascot', () => {
    // y=370 is inside the 232px homeless band on Destin's workArea.
    const l = computeGroupLayout(mascot(1025, 370), SHORT_WA);
    expect(l.mascot.y).not.toBe(370); // he got pushed
    const gap = l.mascot.y > l.chat.y
      ? l.mascot.y - (l.chat.y + CHAT_SIZE.height)   // chat above
      : l.chat.y - (l.mascot.y + MASCOT_SIZE.height); // chat below
    expect(gap).toBe(CHAT_GAP_PX);
  });

  it('bounces the chat away from whichever edge the mascot is nearest', () => {
    // Mascot low in the band → chat bounces UP, mascot pushed down under it.
    const low = computeGroupLayout(mascot(700, 480), SHORT_WA);
    expect(low.chat.y).toBeLessThan(low.mascot.y);
    // Mascot high in the band → chat bounces DOWN, mascot pushed up above it.
    const high = computeGroupLayout(mascot(700, 260), SHORT_WA);
    expect(high.chat.y).toBeGreaterThan(high.mascot.y);
  });

  it('keeps the chat pinned horizontally — it never goes beside the mascot', () => {
    // Regression: an earlier fix put the chat BESIDE the buddy in the band,
    // which broke the pinned horizontal relationship Destin asked for.
    for (let y = 0; y <= SHORT_WA.height - MASCOT_SIZE.height; y += 20) {
      const l = computeGroupLayout(mascot(700, y), SHORT_WA);
      const overlapsHorizontally = l.chat.x < l.mascot.x + MASCOT_SIZE.width
        && l.chat.x + CHAT_SIZE.width > l.mascot.x;
      expect(overlapsHorizontally, `mascot y=${y} → chat x=${l.chat.x}`).toBe(true);
    }
  });

  it('is a fixed point — re-running on its own output changes nothing', () => {
    const once = computeGroupLayout(mascot(1025, 370), SHORT_WA);
    const twice = computeGroupLayout(
      { ...once.mascot, width: 112, height: 112 }, SHORT_WA,
    );
    expect(twice.mascot).toEqual(once.mascot);
    expect(twice.chat).toEqual(once.chat);
  });

  it('handles non-zero workArea origin (secondary monitor)', () => {
    const wa2 = { x: -1440, y: 0, width: 1440, height: 852 };
    const l = computeGroupLayout({ x: -1000, y: 370, width: 112, height: 112 }, wa2);
    expect(l.chat.x).toBeGreaterThanOrEqual(wa2.x);
    expect(l.chat.x + CHAT_SIZE.width).toBeLessThanOrEqual(wa2.x + wa2.width);
    expect(rectsOverlap(l.chat, CHAT_SIZE, l.mascot, MASCOT_SIZE)).toBe(false);
  });
});
