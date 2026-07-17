import { describe, it, expect } from 'vitest';
import { detectSnapEdge, dockReducer, dockPosition, FREE_DOCK } from '../src/main/buddy-dock';

const wa = { x: 0, y: 0, width: 1920, height: 1080 };
const size = { width: 80, height: 80 };

describe('detectSnapEdge', () => {
  it('null when nowhere near an edge', () => {
    expect(detectSnapEdge({ x: 500, y: 500 }, size, wa)).toBeNull();
  });
  it('detects each edge within the 24px threshold', () => {
    expect(detectSnapEdge({ x: 10, y: 500 }, size, wa)).toBe('left');
    expect(detectSnapEdge({ x: 1830, y: 500 }, size, wa)).toBe('right');   // right gap = 1920-1910 = 10
    expect(detectSnapEdge({ x: 500, y: 20 }, size, wa)).toBe('top');
    expect(detectSnapEdge({ x: 500, y: 990 }, size, wa)).toBe('bottom');   // bottom gap = 1080-1070 = 10
  });
  it('25px away is not a snap', () => {
    expect(detectSnapEdge({ x: 25, y: 500 }, size, wa)).toBeNull();
  });
  it('corner picks the nearer edge', () => {
    expect(detectSnapEdge({ x: 5, y: 990 }, size, wa)).toBe('left'); // 5 < 10
  });
  it('respects non-zero workArea origin (secondary monitor)', () => {
    const wa2 = { x: 1920, y: 0, width: 1920, height: 1080 };
    expect(detectSnapEdge({ x: 1925, y: 500 }, size, wa2)).toBe('left');
  });
});

describe('dockReducer', () => {
  it('drag-release with a snap edge docks', () => {
    expect(dockReducer(FREE_DOCK, { type: 'drag-release', snapEdge: 'bottom' }))
      .toEqual({ mode: 'docked', edge: 'bottom' });
  });
  it('drag-release away from edges frees', () => {
    expect(dockReducer({ mode: 'peeking', edge: 'left' }, { type: 'drag-release', snapEdge: null }))
      .toEqual(FREE_DOCK);
  });
  it('idle-timeout peeks only from docked', () => {
    expect(dockReducer({ mode: 'docked', edge: 'left' }, { type: 'idle-timeout' }))
      .toEqual({ mode: 'peeking', edge: 'left' });
    expect(dockReducer(FREE_DOCK, { type: 'idle-timeout' })).toEqual(FREE_DOCK);
  });
  it('activity slides a peeking mascot back to docked', () => {
    expect(dockReducer({ mode: 'peeking', edge: 'right' }, { type: 'activity' }))
      .toEqual({ mode: 'docked', edge: 'right' });
    expect(dockReducer({ mode: 'docked', edge: 'right' }, { type: 'activity' }))
      .toEqual({ mode: 'docked', edge: 'right' });
  });
  it('drag-start undocks (mascot pops out while carried)', () => {
    expect(dockReducer({ mode: 'peeking', edge: 'bottom' }, { type: 'drag-start' })).toEqual(FREE_DOCK);
  });
});

describe('dockPosition', () => {
  it('flush against each edge, other axis preserved + clamped', () => {
    expect(dockPosition('left', { x: 10, y: 500 }, size, wa)).toEqual({ x: 0, y: 500 });
    expect(dockPosition('right', { x: 1830, y: 500 }, size, wa)).toEqual({ x: 1840, y: 500 });
    expect(dockPosition('top', { x: 500, y: 20 }, size, wa)).toEqual({ x: 500, y: 0 });
    expect(dockPosition('bottom', { x: 500, y: 990 }, size, wa)).toEqual({ x: 500, y: 1000 });
  });
});
