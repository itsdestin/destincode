import { describe, it, expect } from 'vitest';
import { BAR_SIZE, computeBarPosition } from '../src/main/buddy-bar-geometry';

const wa = { x: 0, y: 0, width: 1920, height: 1080 };
const mascot = (x: number, y: number) => ({ x, y, width: 80, height: 80 });

describe('computeBarPosition', () => {
  it('centers the bar under the mascot with a 6px gap', () => {
    // mascot center x = 500 + 40 = 540; bar left = 540 - 74 = 466; y = 300 + 80 + 6
    expect(computeBarPosition(mascot(500, 300), wa)).toEqual({ x: 466, y: 386 });
  });

  it('flips above the mascot when below would clip the workArea bottom', () => {
    // mascot at bottom: below-y = 1000 + 80 + 6 = 1086 > 1080 - 44 → flip above
    expect(computeBarPosition(mascot(500, 1000), wa)).toEqual({ x: 466, y: 1000 - BAR_SIZE.height - 6 });
  });

  it('clamps horizontally at the left edge', () => {
    const pos = computeBarPosition(mascot(0, 300), wa);
    expect(pos.x).toBe(0); // raw would be 40 - 74 = -34 → clamped
    expect(pos.y).toBe(386);
  });

  it('clamps horizontally at the right edge', () => {
    const pos = computeBarPosition(mascot(1840, 300), wa);
    expect(pos.x).toBe(wa.width - BAR_SIZE.width);
  });

  it('handles non-zero workArea origin (secondary monitor)', () => {
    const wa2 = { x: 1920, y: 0, width: 1920, height: 1080 };
    expect(computeBarPosition(mascot(1920, 300), wa2).x).toBe(1920);
  });
});
