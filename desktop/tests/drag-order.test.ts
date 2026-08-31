import { describe, it, expect } from 'vitest';
import { nearestPillId, reorderIndices, neighbourOffsets, PILL_GAP } from '../src/renderer/components/header/drag-order';
import { packSessions } from '../src/renderer/components/header/pack-sessions';

// Three 100px pills with a 2px gap: a=[0,100] b=[102,202] c=[204,304]
const rects = [
  { id: 'a', left: 0, right: 100 },
  { id: 'b', left: 102, right: 202 },
  { id: 'c', left: 204, right: 304 },
];

describe('nearestPillId', () => {
  it('picks the pill whose centre is closest to the cursor', () => {
    expect(nearestPillId(rects, 250, 'a')).toBe('c');
    expect(nearestPillId(rects, 150, 'a')).toBe('b');
  });

  it('never picks the pill being dragged', () => {
    // Cursor is dead on b's centre, but b is the one in hand.
    expect(nearestPillId(rects, 152, 'b')).not.toBe('b');
  });

  it('returns null when the dragged pill is the only one', () => {
    expect(nearestPillId([rects[0]], 50, 'a')).toBeNull();
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
