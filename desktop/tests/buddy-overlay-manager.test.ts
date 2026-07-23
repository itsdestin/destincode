import { describe, it, expect } from 'vitest';
import { overlayInitPayload } from '../src/main/buddy-overlay-manager';

describe('overlayInitPayload', () => {
  const bounds = { x: 0, y: 0, width: 1707, height: 1067 };
  const workArea = { x: 0, y: 0, width: 1707, height: 1018 };
  it('converts workArea to window-local and clamps persisted mascot', () => {
    const p = overlayInitPayload(bounds, workArea, { mascot: { x: 5000, y: -50 }, dock: 'right' });
    expect(p.workArea).toEqual({ x: 0, y: 0, width: 1707, height: 1018 });
    expect(p.mascot!.x).toBeLessThanOrEqual(1707 - 112);   // MASCOT_SIZE.width
    expect(p.mascot!.y).toBeGreaterThanOrEqual(0);
    expect(p.dock).toBe('right');
  });
  it('offsets workArea when display bounds do not start at 0 (secondary-display safety)', () => {
    const p = overlayInitPayload({ x: 1707, y: 0, width: 1920, height: 1080 },
      { x: 1707, y: 40, width: 1920, height: 1040 }, { mascot: null, dock: null });
    expect(p.workArea).toEqual({ x: 0, y: 40, width: 1920, height: 1040 });
    expect(p.mascot).toBeNull();
  });
});
