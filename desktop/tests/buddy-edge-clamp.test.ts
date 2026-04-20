import { describe, it, expect } from 'vitest';
import { clampToWorkArea } from '../src/main/buddy-window-manager';

describe('clampToWorkArea', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1080 };

  it('returns input position when fully inside', () => {
    expect(clampToWorkArea({ x: 100, y: 100 }, { width: 80, height: 80 }, wa))
      .toEqual({ x: 100, y: 100 });
  });

  it('clamps right edge when x + width > workArea right', () => {
    expect(clampToWorkArea({ x: 1900, y: 100 }, { width: 80, height: 80 }, wa))
      .toEqual({ x: 1840, y: 100 });
  });

  it('clamps bottom edge when y + height > workArea bottom', () => {
    expect(clampToWorkArea({ x: 100, y: 1060 }, { width: 80, height: 80 }, wa))
      .toEqual({ x: 100, y: 1000 });
  });

  it('clamps negative x/y to work area origin', () => {
    expect(clampToWorkArea({ x: -50, y: -50 }, { width: 80, height: 80 }, wa))
      .toEqual({ x: 0, y: 0 });
  });

  it('handles non-zero workArea origin (secondary monitor)', () => {
    const wa2 = { x: 1920, y: 0, width: 1920, height: 1080 };
    expect(clampToWorkArea({ x: 1900, y: 100 }, { width: 80, height: 80 }, wa2))
      .toEqual({ x: 1920, y: 100 });
  });
});
