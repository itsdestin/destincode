import { describe, it, expect } from 'vitest';
import {
  BAR_SIZE, BAR_GAP_PX, CHAT_SIZE, MASCOT_SIZE, computeBarPosition, computeChatPosition,
} from '../src/main/buddy-bar-geometry';

const wa = { x: 0, y: 0, width: 1920, height: 1080 };
const mascot = (x: number, y: number) => ({ x, y, width: 112, height: 112 });

/** Destin's actual workspace: a 2880×1800 panel at 200% scale, minus taskbar.
 *  Short enough that the chat cannot always fit above or below the mascot. */
const SHORT_WA = { x: 0, y: 0, width: 1440, height: 852 };

const overlaps = (a: { x: number; y: number }, aSize: { width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && a.x + aSize.width > b.x && a.y < b.y + b.height && a.y + aSize.height > b.y;

describe('computeBarPosition', () => {
  it('sits to the right of the mascot, vertically centered on it', () => {
    // mascot center y = 300 + 56; bar top = 356 - 22 = 334; x = 500 + 112 + 6
    expect(computeBarPosition(mascot(500, 300), wa)).toEqual({ x: 618, y: 334 });
  });

  it('flips to the left when the right side would clip the workArea', () => {
    // right would need 1820 + 112 + 6 + 148 > 1920 → flip left of the mascot
    expect(computeBarPosition(mascot(1820, 300), wa)).toEqual({
      x: 1820 - BAR_SIZE.width - BAR_GAP_PX,
      y: 334,
    });
  });

  it('clamps vertically at the top edge', () => {
    expect(computeBarPosition({ x: 500, y: -40, width: 112, height: 112 }, wa).y).toBe(0);
  });

  it('clamps vertically at the bottom edge', () => {
    const pos = computeBarPosition(mascot(500, 1050), wa);
    expect(pos.y).toBe(wa.height - BAR_SIZE.height);
  });

  it('handles non-zero workArea origin (secondary monitor)', () => {
    const wa2 = { x: 1920, y: 0, width: 1920, height: 1080 };
    // mascot flush at wa2's right edge → bar flips left
    expect(computeBarPosition(mascot(1920 + 1920 - 112, 300), wa2).x)
      .toBe(1920 + 1920 - 112 - BAR_SIZE.width - BAR_GAP_PX);
  });
});

describe('computeChatPosition', () => {
  it('hangs below the mascot when there is room', () => {
    const pos = computeChatPosition(mascot(600, 100), wa);
    expect(pos.y).toBe(100 + 112 + 6);
  });

  it('flips above when the chat would not fit below', () => {
    const pos = computeChatPosition(mascot(600, 900), wa);
    expect(pos.y).toBe(900 - CHAT_SIZE.height - 6);
  });

  // The 2026-07-16 regression: on Destin's short workArea the mascot sat at
  // y=370, where neither slot fits. Clamping put the chat at y=0 — right on
  // top of a mascot spanning 370..482 — so the buddy could not be clicked to
  // close the chat it had just opened.
  it('never covers the mascot when neither above nor below fits', () => {
    const mb = { ...mascot(1025, 370) };
    const pos = computeChatPosition(mb, SHORT_WA);
    expect(overlaps(pos, CHAT_SIZE, mb)).toBe(false);
  });

  it('never covers the mascot anywhere on a short workArea', () => {
    for (let y = 0; y <= SHORT_WA.height - MASCOT_SIZE.height; y += 1) {
      const mb = { ...mascot(700, y) };
      const pos = computeChatPosition(mb, SHORT_WA);
      expect(overlaps(pos, CHAT_SIZE, mb), `mascot y=${y} → chat y=${pos.y}`).toBe(false);
    }
  });

  it('keeps the chat fully on screen everywhere on a short workArea', () => {
    for (let y = 0; y <= SHORT_WA.height - MASCOT_SIZE.height; y += 1) {
      const pos = computeChatPosition(mascot(700, y), SHORT_WA);
      expect(pos.x).toBeGreaterThanOrEqual(SHORT_WA.x);
      expect(pos.y).toBeGreaterThanOrEqual(SHORT_WA.y);
      expect(pos.x + CHAT_SIZE.width).toBeLessThanOrEqual(SHORT_WA.x + SHORT_WA.width);
      expect(pos.y + CHAT_SIZE.height).toBeLessThanOrEqual(SHORT_WA.y + SHORT_WA.height);
    }
  });

  it('goes beside on the opposite side from the bar', () => {
    // Mascot mid-screen-left: bar takes the right, so the chat takes the left.
    const mb = { ...mascot(700, 370) };
    const pos = computeChatPosition(mb, SHORT_WA);
    expect(pos.x + CHAT_SIZE.width).toBeLessThanOrEqual(mb.x);
  });

  it('goes beside on the bar side when the preferred side would clip', () => {
    // Mascot hugging the left edge → no room on the left, so the chat goes
    // right even though the bar is there.
    const mb = { ...mascot(0, 370) };
    const pos = computeChatPosition(mb, SHORT_WA);
    expect(pos.x).toBeGreaterThanOrEqual(mb.x + mb.width);
    expect(overlaps(pos, CHAT_SIZE, mb)).toBe(false);
  });

  it('handles non-zero workArea origin (secondary monitor)', () => {
    const wa2 = { x: -1440, y: 0, width: 1440, height: 852 };
    const mb = { x: -1000, y: 370, width: 112, height: 112 };
    const pos = computeChatPosition(mb, wa2);
    expect(pos.x).toBeGreaterThanOrEqual(wa2.x);
    expect(pos.x + CHAT_SIZE.width).toBeLessThanOrEqual(wa2.x + wa2.width);
    expect(overlaps(pos, CHAT_SIZE, mb)).toBe(false);
  });
});
