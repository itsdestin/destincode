import { describe, it, expect } from 'vitest';
import { overlayReducer, overlayLayout, defaultMascotPosition } from '../src/renderer/components/buddy/overlay-state';
import { MASCOT_SIZE, CHAT_SIZE } from '../src/shared/buddy-geometry';

const wa = { x: 0, y: 0, width: 1707, height: 1018 };
const base = { workArea: wa, mascot: { x: 800, y: 500 }, dock: { mode: 'free' as const, edge: null }, chatVisible: false, barVisible: false };

describe('overlayReducer', () => {
  it('drag clamps into workArea (buddy-edge-clamp contract)', () => {
    const s = overlayReducer(base, { type: 'drag-move', to: { x: 99999, y: -50 } });
    expect(s.mascot.x).toBe(wa.width - MASCOT_SIZE.width);
    expect(s.mascot.y).toBe(0);
  });
  it('drag within SNAP_THRESHOLD of an edge → drag-end docks flush (dockReducer contract)', () => {
    const nearRight = overlayReducer(base, { type: 'drag-move', to: { x: wa.width - MASCOT_SIZE.width - 10, y: 500 } });
    const s = overlayReducer(nearRight, { type: 'drag-end' });
    expect(s.dock.mode).toBe('docked');
    expect(s.dock.edge).toBe('right');
  });
  it('bar only ever visible with chat (PITFALLS: bar opens with the chat and nothing else)', () => {
    const open = overlayReducer(base, { type: 'toggle-chat' });
    expect(open.chatVisible).toBe(true); expect(open.barVisible).toBe(true);
    const closed = overlayReducer(open, { type: 'toggle-chat' });
    expect(closed.barVisible).toBe(false);
  });
  it('disengage from peeking re-flushes to the edge (PITFALLS: hanging-off-nothing)', () => {
    const docked = { ...base, dock: { mode: 'peeking' as const, edge: 'right' as const }, mascot: { x: 900, y: 500 } };
    const s = overlayReducer(docked, { type: 'disengage' });
    expect(s.mascot.x).toBe(wa.width - MASCOT_SIZE.width); // flush, not stranded
  });
});

describe('overlayLayout', () => {
  it('chat position comes from computeGroupLayout — chat never offscreen', () => {
    const s = { ...base, mascot: { x: wa.width - MASCOT_SIZE.width, y: 300 }, chatVisible: true, barVisible: true };
    const l = overlayLayout(s);
    expect(l.chat.x + CHAT_SIZE.width).toBeLessThanOrEqual(wa.width);
    expect(l.chat.x).toBeGreaterThanOrEqual(0);
  });
});

describe('defaultMascotPosition', () => {
  it('lands inside the work area', () => {
    const p = defaultMascotPosition(wa);
    expect(p.x + MASCOT_SIZE.width).toBeLessThanOrEqual(wa.width);
    expect(p.y + MASCOT_SIZE.height).toBeLessThanOrEqual(wa.height);
  });
});
