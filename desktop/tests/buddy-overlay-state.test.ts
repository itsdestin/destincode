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

  // Coordinator review finding 1: overlayLayout was deriving the rendered
  // mascot from computeGroupLayout unconditionally, so the chat-fit x-pin
  // applied even with the chat CLOSED — a free mascot dragged flush to the
  // right edge rendered ~191px off the edge (PITFALLS "hanging off nothing").
  it('chat-closed: rendered mascot is state.mascot, flush to the edge — not chat-fit pinned', () => {
    const dragged = overlayReducer(base, { type: 'drag-move', to: { x: 99999, y: 500 } });
    expect(dragged.chatVisible).toBe(false);
    const flush = wa.width - MASCOT_SIZE.width;
    expect(dragged.mascot.x).toBe(flush); // sanity: reducer clamped flush, not chat-fit pinned
    const l = overlayLayout(dragged);
    expect(l.mascot).toEqual(dragged.mascot);
    expect(l.mascot.x).toBe(flush);
  });

  it('chat-open: rendered mascot still matches state (adoption keeps them equal)', () => {
    const opened = overlayReducer({ ...base, mascot: { x: wa.width - MASCOT_SIZE.width, y: 300 } }, { type: 'toggle-chat' });
    expect(opened.chatVisible).toBe(true);
    const l = overlayLayout(opened);
    expect(l.mascot).toEqual(opened.mascot);
  });
});

describe('defaultMascotPosition', () => {
  it('lands inside the work area', () => {
    const p = defaultMascotPosition(wa);
    expect(p.x + MASCOT_SIZE.width).toBeLessThanOrEqual(wa.width);
    expect(p.y + MASCOT_SIZE.height).toBeLessThanOrEqual(wa.height);
  });
});

// Fix pass (coordinator finding 2): chat-open drag must honor the rigid-group
// invariant — ported from BuddyWindowManager.moveMascot/dragEnded's
// `chatOpen` branches (src/main/buddy-window-manager.ts). These are ADDED
// tests; the brief's tests above are untouched.
describe('overlayReducer — chat-open drag (rigid-group)', () => {
  const openBase = { ...base, chatVisible: true, barVisible: true };

  it('drag with chat open x-pins the mascot to keep the chat on screen, not the raw workArea clamp', () => {
    // x=1500 is inside the plain workArea clamp (needs no clamping, and is
    // more than PEEK_PAST_EDGE_PX from the true edge, so no shove fires) but
    // outside mascotXRangeForChat's max (1404) — isolates the x-pin from both
    // the ordinary clamp and the shove-to-close path.
    const s = overlayReducer(openBase, { type: 'drag-move', to: { x: 1500, y: 500 } });
    expect(s.mascot.x).toBe(1404);
    expect(s.mascot.x).toBeLessThan(wa.width - MASCOT_SIZE.width);
    expect(s.mascot.y).toBe(500);
    expect(s.dock.mode).toBe('free'); // never snaps/docks while the chat is open
  });

  it('drag past the edge while chat is open shoves it away — closes chat, peeks (PEEK_PAST_EDGE_PX)', () => {
    const s = overlayReducer(openBase, { type: 'drag-move', to: { x: wa.width - MASCOT_SIZE.width - 3, y: 500 } });
    expect(s.chatVisible).toBe(false);
    expect(s.barVisible).toBe(false);
    expect(s.dock).toEqual({ mode: 'peeking', edge: 'right' });
    expect(s.mascot.x).toBe(wa.width - MASCOT_SIZE.width);
  });

  it('drag-end never docks while the chat is open — settles onto computeGroupLayout instead', () => {
    const near = { ...openBase, mascot: { x: wa.width - MASCOT_SIZE.width, y: 500 } };
    const s = overlayReducer(near, { type: 'drag-end' });
    expect(s.dock.mode).toBe('free');
    expect(s.mascot.x).toBe(1404); // the chat-open x-pin range, not the edge
  });
});

// Fix pass (coordinator finding 3): the toggle-chat rigid-group adoption
// branch had zero coverage — assert the ADOPTED position lands in STATE, not
// just in overlayLayout's derived output.
describe('overlayReducer — toggle-chat rigid-group adoption', () => {
  it('toggle-chat adopts a squashed mascot position into state (rigid-group rule)', () => {
    // y=450 sits in the tier-3 "neither above nor below fits" band for this
    // workArea (computeGroupLayout, buddy-geometry.ts) — opening the chat
    // here forces a vertical squash.
    const squeeze = { ...base, mascot: { x: 700, y: 450 } };
    const opened = overlayReducer(squeeze, { type: 'toggle-chat' });
    expect(opened.mascot).toEqual({ x: 700, y: 420 });
    expect(opened.mascot).not.toEqual(squeeze.mascot); // proves adoption actually moved it
  });
});
