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
  // Destin 2026-07-17: dropping him on an edge IS putting him away. Peek used
  // to be reachable only by docking and then waiting out an 8s idle timer,
  // which made it something that happened TO you rather than something you did.
  it('drag-release on an edge peeks immediately — no idle timer', () => {
    expect(dockReducer(FREE_DOCK, { type: 'drag-release', snapEdge: 'bottom' }))
      .toEqual({ mode: 'peeking', edge: 'bottom' });
  });
  it('drag-release away from edges frees', () => {
    expect(dockReducer({ mode: 'peeking', edge: 'left' }, { type: 'drag-release', snapEdge: null }))
      .toEqual(FREE_DOCK);
  });
  it('drag-start undocks (dragging him off the edge brings him back out)', () => {
    expect(dockReducer({ mode: 'peeking', edge: 'bottom' }, { type: 'drag-start' })).toEqual(FREE_DOCK);
  });

  it('engage brings a peeking mascot out and holds him there', () => {
    expect(dockReducer({ mode: 'peeking', edge: 'right' }, { type: 'engage' }))
      .toEqual({ mode: 'docked', edge: 'right' });
    expect(dockReducer({ mode: 'docked', edge: 'right' }, { type: 'engage' }))
      .toEqual({ mode: 'docked', edge: 'right' });
  });
  it('disengage sinks a docked mascot back into peek', () => {
    expect(dockReducer({ mode: 'docked', edge: 'right' }, { type: 'disengage' }))
      .toEqual({ mode: 'peeking', edge: 'right' });
  });
  it('engage/disengage never drag a free mascot to an edge', () => {
    expect(dockReducer(FREE_DOCK, { type: 'engage' })).toEqual(FREE_DOCK);
    expect(dockReducer(FREE_DOCK, { type: 'disengage' })).toEqual(FREE_DOCK);
  });
  it('round-trips: peek → engage → disengage → peek, edge preserved', () => {
    const peek = { mode: 'peeking' as const, edge: 'left' as const };
    const out = dockReducer(peek, { type: 'engage' });
    expect(dockReducer(out, { type: 'disengage' })).toEqual(peek);
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
