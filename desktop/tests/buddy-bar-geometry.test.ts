import { describe, it, expect } from 'vitest';
import { BAR_SIZE, BAR_GAP_PX, computeBarPosition } from '../src/main/buddy-bar-geometry';

const wa = { x: 0, y: 0, width: 1920, height: 1080 };
const mascot = (x: number, y: number) => ({ x, y, width: 112, height: 112 });

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
