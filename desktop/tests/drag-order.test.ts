import { describe, it, expect } from 'vitest';
import {
  nearestSlotId, slotCentres, clampDragDx, reorderIndices, neighbourOffsets, PILL_GAP,
} from '../src/renderer/components/header/drag-order';
import { packSessions } from '../src/renderer/components/header/pack-sessions';

// Three 100px pills with a 2px gap: a=[0,100] b=[102,202] c=[204,304]
const rects = [
  { id: 'a', left: 0, right: 100 },
  { id: 'b', left: 102, right: 202 },
  { id: 'c', left: 204, right: 304 },
];

// Non-uniform widths are the whole point: a wide active pill among dots.
const mixed = [
  { id: 'wide', left: 0, right: 179 },   // the active pill
  { id: 'd1', left: 181, right: 205 },
  { id: 'd2', left: 207, right: 231 },
  { id: 'd3', left: 233, right: 257 },
];

describe('slotCentres', () => {
  it('is where the dragged pill would sit at each position, others keeping their order', () => {
    // a (100 wide) at position 0, 1, 2 among b and c.
    expect(slotCentres(rects, 'a', 2)).toEqual([50, 152, 254]);
  });

  it('handles mixed widths — the dots flow under a wide pill one at a time', () => {
    // wide (179) at each of four positions among three 24px dots.
    expect(slotCentres(mixed, 'wide', 2)).toEqual([89.5, 115.5, 141.5, 167.5]);
  });

  it('is empty when the dragged id is not in the row (a drag from the menu)', () => {
    expect(slotCentres(rects, 'zz', 2)).toEqual([]);
  });
});

describe('nearestSlotId', () => {
  it('names the pill whose slot the dragged centre is nearest to', () => {
    expect(nearestSlotId(rects, 'a', 250, 2)).toBe('c');
    expect(nearestSlotId(rects, 'a', 140, 2)).toBe('b');
  });

  it('is null while the pill is nearest its own slot', () => {
    expect(nearestSlotId(rects, 'a', 60, 2)).toBeNull();
    expect(nearestSlotId(rects, 'b', 152, 2)).toBeNull();
  });

  it('keeps a wide pill within half a dot of its hole (the 2026-09-01 drag void)', () => {
    // The old nearest-NEIGHBOUR test needed the cursor at a dot's centre before
    // that dot stepped aside, so a 179px pill overlapped three dots before its
    // gap opened. Now the gap follows the pill's centre: 13px past the first
    // slot centre it is already heading for d1's slot.
    expect(nearestSlotId(mixed, 'wide', 89.5 + 12, 2)).toBeNull();
    expect(nearestSlotId(mixed, 'wide', 89.5 + 14, 2)).toBe('d1');
    expect(nearestSlotId(mixed, 'wide', 167.5, 2)).toBe('d3');
  });

  it('is null when the dragged pill is the only one', () => {
    expect(nearestSlotId([rects[0]], 'a', 50, 2)).toBeNull();
  });
});

describe('clampDragDx', () => {
  it('lets the pill travel from the first pill\'s left edge to the last pill\'s right edge', () => {
    expect(clampDragDx(rects, 'b', -500)).toBe(-102);
    expect(clampDragDx(rects, 'b', 500)).toBe(102);
    expect(clampDragDx(rects, 'b', 30)).toBe(30);
  });

  it('pins an unknown id in place', () => {
    expect(clampDragDx(rects, 'zz', 40)).toBe(0);
  });
});

describe('reorderIndices', () => {
  it('resolves both ends against the FULL session list', () => {
    expect(reorderIndices(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual({ from: 0, to: 2 });
  });

  it('stays correct when pills are missing from the strip (overflow)', () => {
    // THE REGRESSION. The strip shows a, c, d — b is in the "+1" overflow
    // bucket. Dropping a onto d is canonical (0 -> 3). The old code passed a
    // canonical "from" and a VISIBLE "to" (0 -> 2), which App.tsx spliced into
    // the wrong slot. Ids cannot desync.
    const all = ['a', 'b', 'c', 'd'];
    expect(reorderIndices(all, 'a', 'd')).toEqual({ from: 0, to: 3 });
  });

  it('returns null for an id that is not in the list', () => {
    expect(reorderIndices(['a', 'b'], 'a', 'zz')).toBeNull();
  });
});

describe('neighbourOffsets', () => {
  it('slides the pills between source and target LEFT when dragging right', () => {
    // a (100 wide) heads for c's slot: b and c step left by 100 + 2.
    const o = neighbourOffsets(rects, 'a', 'c', 2);
    expect(o.get('b')).toBe(-102);
    expect(o.get('c')).toBe(-102);
    expect(o.get('a')).toBeUndefined(); // the dragged pill is positioned by the cursor
  });

  it('slides them RIGHT when dragging left', () => {
    const o = neighbourOffsets(rects, 'c', 'a', 2);
    expect(o.get('a')).toBe(102);
    expect(o.get('b')).toBe(102);
  });

  it('moves nothing when there is no target', () => {
    expect(neighbourOffsets(rects, 'a', null, 2).size).toBe(0);
  });

  it('moves nothing when the target is the dragged pill itself', () => {
    expect(neighbourOffsets(rects, 'b', 'b', 2).size).toBe(0);
  });

  it('opens a hole exactly the size of the slot the pill is heading for', () => {
    // The row's total width must not change: the three dots vacate on the
    // right (each steps over by the wide pill's 179 + gap) what the wide pill
    // vacates on the left, and the slot it is heading for — three dots plus
    // gaps to the right of its origin — is where slotCentres says it sits.
    const offs = neighbourOffsets(mixed, 'wide', 'd3', 2);
    expect(offs.get('d1')).toBe(-181);
    expect(offs.get('d3')).toBe(-181);
    expect(slotCentres(mixed, 'wide', 2)[3]).toBe(89.5 + 3 * 26);
  });
});

describe('the index spaces the strip used to mix', () => {
  // This is the regression, demonstrated with the REAL packer rather than a
  // hand-made overflow list — so it proves the divergence is reachable in the
  // shipping layout, not just constructible on paper.
  //
  // packSessions keeps the active pill plus a PREFIX of the others and pushes
  // the tail into the "+N" chip. visibleSessions then filters the full array,
  // preserving canonical order. So the moment the active session sits past
  // that prefix, the visible list is [0, 1, …, k, active] — and the active
  // pill's position in it is NOT its position in `sessions`.
  //
  // The old code read `dragIdx` from the full array and each pill's
  // `data-session-idx` from the visible one, then handed both straight to
  // onReorderSessions. Dragging the active pill therefore spliced the wrong row.
  it('diverges on the active pill once the strip overflows', () => {
    const sessions = Array.from({ length: 8 }, (_, i) => ({
      id: `s${i}`,
      expandedWidth: 120,
      collapsedWidth: 24,
    }));
    // Budget fits the active pill (120) plus a couple of dots, nothing near all 8.
    const pack = packSessions({
      sessions, activeId: 's5', budget: 220, gap: PILL_GAP, triggerWidth: 24,
    });
    expect(pack.overflow.length).toBeGreaterThan(0);   // the "+N" chip is showing

    const visible = sessions
      .filter(s => pack.expanded.has(s.id) || pack.collapsed.includes(s.id))
      .map(s => s.id);
    expect(visible).toContain('s5');

    const visibleIdx = visible.indexOf('s5');
    const canonicalIdx = sessions.findIndex(s => s.id === 's5');
    expect(visibleIdx).not.toBe(canonicalIdx);          // ← the bug, reproduced

    // What the strip does now: both ends resolved against the full list, by id.
    expect(reorderIndices(sessions.map(s => s.id), 's5', visible[0]))
      .toEqual({ from: canonicalIdx, to: 0 });
  });
});
