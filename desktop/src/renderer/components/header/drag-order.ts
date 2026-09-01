// Where a dragged session pill lands, and how the pills around it get out of
// the way. Pure so it can be tested without mounting SessionStrip.
//
// EVERYTHING HERE IS KEYED BY SESSION ID, NEVER BY INDEX. That is the whole
// point of the module. The strip used to mix two index spaces: `dragIdx` was
// resolved against the FULL sessions array, while each pill's data attribute
// carried its index into the VISIBLE subset. Those agree only while every
// session fits — the moment packSessions pushes one into its `overflow`
// bucket (the "+N" chip), they diverge, and onReorderSessions was called with
// a canonical "from" and a visible "to". App.tsx spliced into the wrong slot,
// and the strip dimmed the wrong pill for the whole drag.
// Ids are unique (pack-sessions.ts: "Caller guarantees session ids are unique")
// so no index space can drift out from under them again.
import { PILL_GAP } from './pack-sessions';

export { PILL_GAP };

/** One pill's horizontal extent, in client coordinates. */
export interface PillRect {
  id: string;
  left: number;
  right: number;
}

/** The pill whose horizontal centre is nearest the cursor, excluding the one
 *  in hand. Y is deliberately ignored: the pickup range is the full height of
 *  the window so a slightly-low drag still reorders instead of doing nothing. */
export function nearestPillId(
  rects: readonly PillRect[],
  clientX: number,
  draggedId: string,
): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const r of rects) {
    if (r.id === draggedId) continue;
    const dist = Math.abs(clientX - (r.left + r.right) / 2);
    if (dist < bestDist) {
      bestDist = dist;
      best = r.id;
    }
  }
  return best;
}

/** Canonical from/to for `onReorderSessions`, which splices into the full
 *  sessions array. Null when either id is unknown — a session can close
 *  mid-drag, and reordering against a stale list is worse than not reordering. */
export function reorderIndices(
  sessionIds: readonly string[],
  fromId: string,
  toId: string,
): { from: number; to: number } | null {
  const from = sessionIds.indexOf(fromId);
  const to = sessionIds.indexOf(toId);
  if (from === -1 || to === -1) return null;
  return { from, to };
}

/** How far each pill slides to open the gap the dragged pill is heading for,
 *  in CSS px (negative = left). The dragged pill is absent from the map: it is
 *  positioned by the cursor, not by this.
 *
 *  Chrome's model: every tab between the dragged tab's origin and its target
 *  steps over by exactly one tab-width, so the row never changes total width
 *  and the gap IS the insertion indicator. */
export function neighbourOffsets(
  rects: readonly PillRect[],
  draggedId: string,
  overId: string | null,
  gap: number = PILL_GAP,
): Map<string, number> {
  const out = new Map<string, number>();
  if (overId === null || overId === draggedId) return out;

  const from = rects.findIndex(r => r.id === draggedId);
  const to = rects.findIndex(r => r.id === overId);
  if (from === -1 || to === -1) return out;

  const dragged = rects[from];
  const shift = dragged.right - dragged.left + gap;

  if (to > from) {
    // Dragging right: everything from just after the origin through the target
    // steps LEFT into the space the dragged pill vacated.
    for (let i = from + 1; i <= to; i++) out.set(rects[i].id, -shift);
  } else {
    for (let i = to; i < from; i++) out.set(rects[i].id, shift);
  }
  return out;
}

/** How far the DRAGGED pill must move to sit in the slot it is heading for.
 *
 *  WHY this exists rather than just following the cursor: Chrome can put the
 *  tab in hand exactly under the pointer because every tab is the same width,
 *  so the gap that opens is always tab-width and the tab always fits it. Our
 *  pills are not uniform — the active one is ~179px and the rest are 24px dots.
 *  Measured 2026-08-31: dragging the active pill past three dots opened its gap
 *  at +78px while the cursor carried the pill to +166px, so it floated ~90px
 *  clear of its own hole and overlapped the dots to its right. Positioning it
 *  by slot keeps the row coherent at any mix of widths. */
export function draggedSlotOffset(
  rects: readonly PillRect[],
  draggedId: string,
  overId: string | null,
  gap: number = PILL_GAP,
): number {
  if (overId === null || overId === draggedId) return 0;
  const from = rects.findIndex(r => r.id === draggedId);
  const to = rects.findIndex(r => r.id === overId);
  if (from === -1 || to === -1) return 0;

  // The dragged pill steps over each crossed neighbour by that NEIGHBOUR's
  // width — the mirror of neighbourOffsets, which steps each of them over by
  // the dragged pill's width. Together the row's total width is unchanged.
  let shift = 0;
  if (to > from) {
    for (let i = from + 1; i <= to; i++) shift += rects[i].right - rects[i].left + gap;
  } else {
    for (let i = to; i < from; i++) shift -= rects[i].right - rects[i].left + gap;
  }
  return shift;
}
