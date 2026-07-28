/**
 * Geometry for the traced selection outline (spec 2026-07-26 §5.6).
 *
 * Pure on purpose: this is the trickiest logic in the feature and the part most
 * likely to be silently wrong, so it must be testable without a DOM or a render.
 */

export type Box = { l: number; r: number; t: number; b: number };

/**
 * Host-relative, padded, sorted line boxes from raw client rects.
 * Zero-area rects are dropped — a collapsed range emits them and they would
 * add a degenerate spike to the outline.
 */
export function toBoxes(rects: DOMRect[], host: DOMRect, pad = 2): Box[] {
  return rects
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({
      l: r.left - host.left - pad,
      r: r.right - host.left + pad,
      t: r.top - host.top - pad,
      b: r.bottom - host.top + pad,
    }))
    .sort((a, b) => a.t - b.t);
}

/**
 * The stepped union outline: walk DOWN the right edges of every line box, then
 * back UP the left edges. For a selection that starts mid-line and ends
 * mid-line this produces the familiar notched shape rather than a bounding box.
 */
export function buildUnionPath(boxes: Box[]): string {
  if (boxes.length === 0) return '';
  const cmds: string[] = [];
  boxes.forEach((bx, i) => {
    cmds.push(`${i === 0 ? 'M' : 'L'} ${bx.r} ${bx.t}`, `L ${bx.r} ${bx.b}`);
  });
  for (let i = boxes.length - 1; i >= 0; i--) {
    cmds.push(`L ${boxes[i].l} ${boxes[i].b}`, `L ${boxes[i].l} ${boxes[i].t}`);
  }
  cmds.push('Z');
  return cmds.join(' ');
}

/**
 * Shifts every coordinate pair in a `buildUnionPath` string by (dx, dy).
 *
 * Task 8's artifact-reference clip-path needs this: `d` is built in VIEWPORT
 * coordinates (use-reference-geometry.ts's `origin = {left:0,top:0}` — a
 * carry-over from when it also fed a `position:fixed; inset:0` traced SVG,
 * `.reference-trace`, since removed in a dev-review pass; the viewport-origin
 * choice stayed because it's still the natural coordinate space for a
 * `getBoundingClientRect()`-derived path). CSS `clip-path: path(...)`
 * resolves its coordinates against the top-left of the
 * CLIPPED ELEMENT'S OWN reference box (border-box by default) — the same rule
 * `polygon()`/`circle()` use for percentages — NOT the viewport. The lifted
 * clone's box is pinned at the source's rect, not at (0,0), so its path must
 * be re-expressed relative to that box's own origin: pass
 * `shiftPath(d, -rect.left, -rect.top)`.
 *
 * Only handles the M/L pairs `buildUnionPath` emits (no curves, no relative
 * commands) — sufficient because it is the only producer of this path format.
 */
export function shiftPath(d: string, dx: number, dy: number): string {
  if (!d) return d;
  return d.replace(/([ML]) (-?[\d.]+) (-?[\d.]+)/g, (_match, cmd: string, x: string, y: string) =>
    `${cmd} ${Number(x) + dx} ${Number(y) + dy}`,
  );
}
