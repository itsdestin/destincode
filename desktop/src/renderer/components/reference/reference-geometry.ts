/**
 * Geometry for the traced selection outline (spec 2026-07-26 §5.6; restored
 * 2026-07-28 after a dev-review pass deleted it as "uneven and janky" — see
 * the WHY comments below for what actually changed this time around).
 *
 * Pure on purpose: this is the trickiest logic in the feature and the part most
 * likely to be silently wrong, so it must be testable without a DOM or a render.
 */

export type Box = { l: number; r: number; t: number; b: number };

/**
 * Host-relative, padded, sorted line boxes from raw client rects.
 *
 * Snaps every edge to a whole pixel (Math.round). Restoration fix: real
 * browsers hand back sub-pixel DOMRect values (fractional left/top/right/
 * bottom from font hinting, device-pixel-ratio scaling, etc.) — carrying
 * those through unrounded was a direct source of visible jitter in the old
 * traced outline, especially while the reference card was mid-FLIP-travel
 * and re-measuring every frame: two rects that are visually "the same line,
 * still" but differ by a fraction of a pixel produced a wobbling edge
 * instead of a stable one. Rounding once, at the DOMRect -> Box boundary
 * (the one place raw measurements enter this pure pipeline), means every
 * downstream consumer (merge, path-building) works with stable integers.
 *
 * Drops near-zero rects (< 0.5px wide or tall) — a collapsed range emits
 * degenerate zero-area rects, and real text line boxes are never sub-pixel
 * tall, so anything under 0.5px is measurement noise, not content.
 */
export function toBoxes(rects: DOMRect[], host: DOMRect, pad = 2): Box[] {
  const real = rects.filter((r) => r.width > 0.5 && r.height > 0.5);

  // Union rects that land on the SAME rendered line, BEFORE padding.
  //
  // Fix (2026-07-28 outline-geometry-fix): a selection that starts or ends
  // mid-line can cross a syntax-highlighting token boundary — apply-highlight.ts
  // deliberately wraps EACH covered text node in its own <mark> when that
  // happens ("a selection that straddles two <span> tokens... gets one <mark>
  // per covered node" — see its WHY comment), so one partially-selected LINE
  // can hand back MULTIPLE client rects, not one. buildRoundedOutlinePath's
  // traversal (down every box's right edge, then back up every box's left
  // edge) only produces a valid, non-self-crossing polygon when there is AT
  // MOST ONE box per line — feeding it >1 box for the same line interleaves
  // that line's edges with the NEXT line's, producing a self-intersecting
  // path whose fill (`.reference-trace path.wash`) bleeds outside the actual
  // highlighted runs. That bleed is what read as "a larger box around the
  // whole two-line region" alongside the correctly-tight `.reference-mark`
  // backgrounds (Destin, 2026-07-28 screenshot report) — confirmed by
  // feeding this exact shape (2 marks on line 1, 1 on line 2) through the
  // pre-fix pipeline and inspecting the emitted path: (320,20) and (320,0)
  // each appeared twice, at unrelated points in the traversal.
  //
  // Grouped by comparing RAW (unpadded) vertical midpoints with a small (1px)
  // epsilon: same-line fragments share a near-identical midpoint (sub-pixel
  // apart at most, from font-metric rounding); genuinely adjacent — but
  // different — lines are a full line-height apart, so this can never
  // conflate two real lines into one. Done here, pre-pad, deliberately: `pad`
  // is added symmetrically to both edges of every box, so it never shifts a
  // box's own vertical MIDPOINT — but comparing PADDED [t,b] *ranges* for
  // overlap would false-positive on any two ordinarily-stacked lines with
  // zero natural gap between them, since padding pushes both toward each
  // other by `pad` each. That's the normal case for body text, so padded-
  // range overlap was rejected as the grouping test.
  const sorted = [...real].sort((a, b) => a.top - b.top);
  const lines: DOMRect[][] = [];
  for (const r of sorted) {
    const curMid = (r.top + r.bottom) / 2;
    const line = lines[lines.length - 1];
    if (line) {
      const lineMid = (line[0].top + line[0].bottom) / 2;
      if (Math.abs(curMid - lineMid) <= 1) {
        line.push(r);
        continue;
      }
    }
    lines.push([r]);
  }

  return lines
    .map((group) => {
      const l = Math.min(...group.map((r) => r.left));
      const r = Math.max(...group.map((r) => r.right));
      const t = Math.min(...group.map((r) => r.top));
      const b = Math.max(...group.map((r) => r.bottom));
      return {
        l: Math.round(l - host.left - pad),
        r: Math.round(r - host.left + pad),
        t: Math.round(t - host.top - pad),
        b: Math.round(b - host.top + pad),
      };
    })
    .sort((a, b) => a.t - b.t);
}

/**
 * Snaps consecutive line boxes' left/right edges to a shared value when
 * they're within `tolerance` px of each other.
 *
 * Restoration fix: the old outline joined raw per-line rects with hard 90°
 * steps, so two lines that are — to the eye — the same width (e.g. two full
 * lines of a wrapped paragraph) but differ by a stray 1-2px of sub-pixel
 * font-metric noise produced a visible micro "staircase" notch even after
 * pixel-snapping alone. `tolerance = 2` mirrors the existing `pad` default
 * above: real content differences (a selection starting mid-line, a shorter
 * final line) are always at least one character's width apart — several
 * pixels at minimum — so a 2px tolerance merges only the noise, never a
 * genuine edge. `boxes` is assumed pre-sorted by `t`, AND at most one box per
 * visual line (toBoxes already guarantees both — see its WHY comment on the
 * line-grouping pass), so "consecutive in the array" is "consecutive
 * top-to-bottom, one step per line" — exactly the adjacency the visible
 * staircase comes from. Callers that skip toBoxes and hand-build a `Box[]`
 * with >1 box on the same line (as some tests deliberately do, to test this
 * function in isolation) will see this smoothing pass compare across those
 * too — harmless for hand-built same-line-adjacent boxes in existing tests,
 * but not a substitute for toBoxes' grouping, which is what actually
 * prevents the self-crossing traversal bug (see toBoxes).
 */
export function mergeAdjacentBoxes(boxes: Box[], tolerance = 2): Box[] {
  if (boxes.length < 2) return boxes;
  // Copy rather than mutate the input — callers (tests, the geometry hook)
  // may hold onto the original array.
  const merged = boxes.map((b) => ({ ...b }));
  for (let i = 1; i < merged.length; i++) {
    const prev = merged[i - 1];
    const cur = merged[i];
    if (Math.abs(cur.l - prev.l) <= tolerance) {
      const l = Math.min(prev.l, cur.l);
      prev.l = l;
      cur.l = l;
    }
    if (Math.abs(cur.r - prev.r) <= tolerance) {
      const r = Math.max(prev.r, cur.r);
      prev.r = r;
      cur.r = r;
    }
  }
  return merged;
}

/**
 * The stepped union outline: walk DOWN the right edges of every line box, then
 * back UP the left edges. For a selection that starts mid-line and ends
 * mid-line this produces the familiar notched shape rather than a bounding box.
 *
 * Kept exactly as it was (sharp corners, no snap/merge baked in) — it's still
 * a valid, independently-tested pure primitive, and other code may reasonably
 * want the raw union without the outline-specific smoothing pass. Production
 * rendering (the traced SVG, the artifact clip-path) now goes through
 * `buildRoundedOutlinePath` instead — see its WHY comment for the rounding
 * approach and why sharp-cornered `buildUnionPath` output was the "uneven and
 * janky" complaint that got this feature deleted the first time.
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

type Point = { x: number; y: number };

/**
 * Same traversal `buildUnionPath` uses (down the right edges, back up the
 * left) but as raw {x,y} points instead of a command string, with
 * consecutive duplicate points collapsed. Boxes that share an edge (two
 * vertically stacked line boxes, or the merge pass above snapping two edges
 * to the same value) emit the same coordinate twice in a row in the raw
 * traversal — a zero-length "edge" that can't be rounded (there is no
 * direction to fillet a corner along), so it must be removed before the
 * rounding pass, not just left as a degenerate control point.
 */
function unionVertices(boxes: Box[]): Point[] {
  const pts: Point[] = [];
  for (const bx of boxes) {
    pts.push({ x: bx.r, y: bx.t });
    pts.push({ x: bx.r, y: bx.b });
  }
  for (let i = boxes.length - 1; i >= 0; i--) {
    pts.push({ x: boxes[i].l, y: boxes[i].b });
    pts.push({ x: boxes[i].l, y: boxes[i].t });
  }
  const deduped: Point[] = [];
  for (const p of pts) {
    const last = deduped[deduped.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) deduped.push(p);
  }
  // The traversal can also close on itself exactly (the first and last
  // points coincide) for some box shapes — drop the trailing duplicate so
  // the polygon doesn't get a zero-length closing edge either.
  if (deduped.length > 1) {
    const first = deduped[0];
    const last = deduped[deduped.length - 1];
    if (first.x === last.x && first.y === last.y) deduped.pop();
  }
  return deduped;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Point on the segment from `from` to `to`, at distance `dist` from `from`. */
function pointToward(from: Point, to: Point, dist: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1; // guard a zero-length edge (shouldn't occur post-dedup, but don't divide by zero if it does)
  const t = dist / len;
  return { x: round2(from.x + dx * t), y: round2(from.y + dy * t) };
}

/**
 * The traced outline, restored: same stepped union as `buildUnionPath`, but
 * with every vertex rounded off — this is the actual fix for "uneven and
 * janky." A rectilinear staircase reads as sharp and mechanical, especially
 * at the notches where a selection starts/ends mid-line; rounding every
 * corner (not just the outer four) turns it into a single continuous,
 * organic-looking trace.
 *
 * Technique: for each vertex, back off by `radius` along BOTH adjacent edges
 * (clamped to half the shorter of the two, per-vertex — a short run, like a
 * single narrow selected word, must not get corners so large they touch or
 * overshoot each other and distort the shape into a lozenge) to get two
 * "shoulder" points, draw a straight line to the first, then a quadratic
 * Bézier (control point = the original sharp corner) out to the second.
 * Quadratic, not arc/`A`: the SVG arc command's parameters (rx, ry,
 * x-axis-rotation, large-arc-flag, sweep-flag, x, y) aren't uniformly
 * "coordinates to shift" the way `shiftPath` needs — a naive shift would
 * corrupt the flags — while a quadratic's two (x,y) pairs shift exactly like
 * `M`/`L` already do.
 */
export function buildRoundedOutlinePath(boxes: Box[], radius = 6): string {
  if (boxes.length === 0) return '';
  const pts = unionVertices(boxes);
  const n = pts.length;
  if (n < 3) return ''; // not enough distinct vertices to form a shape at all

  const cmds: string[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];

    const distPrev = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const distNext = Math.hypot(next.x - cur.x, next.y - cur.y);
    const rr = Math.min(radius, distPrev / 2, distNext / 2);

    const shoulderIn = pointToward(cur, prev, rr);
    const shoulderOut = pointToward(cur, next, rr);

    cmds.push(i === 0 ? `M ${shoulderIn.x} ${shoulderIn.y}` : `L ${shoulderIn.x} ${shoulderIn.y}`);
    cmds.push(`Q ${cur.x} ${cur.y} ${shoulderOut.x} ${shoulderOut.y}`);
  }
  cmds.push('Z');
  return cmds.join(' ');
}

/**
 * Shifts every coordinate pair in a path string by (dx, dy).
 *
 * Task 8's artifact-reference clip-path needs this: `d` is built in VIEWPORT
 * coordinates (use-reference-geometry.ts's `origin = {left:0,top:0}` — the
 * traced outline is `position:fixed; inset:0`, so the viewport IS its
 * coordinate space). CSS `clip-path: path(...)` resolves its coordinates
 * against the top-left of the CLIPPED ELEMENT'S OWN reference box (border-box
 * by default) — the same rule `polygon()`/`circle()` use for percentages —
 * NOT the viewport. The lifted clone's box is pinned at the source's rect,
 * not at (0,0), so its path must be re-expressed relative to that box's own
 * origin: pass `shiftPath(d, -rect.left, -rect.top)`.
 *
 * Handles `M`/`L` (one coordinate pair) and `Q` (two pairs — control point,
 * then endpoint; both shift the same way, since a Bézier control point lives
 * in the same coordinate space as the curve itself) — the full command
 * vocabulary `buildUnionPath` and `buildRoundedOutlinePath` emit between
 * them. `Z` carries no coordinates and passes through untouched.
 */
export function shiftPath(d: string, dx: number, dy: number): string {
  if (!d) return d;
  return d.replace(/([MLQ])((?:\s+-?[\d.]+){2,4})/g, (_match, cmd: string, nums: string) => {
    const values = nums.trim().split(/\s+/).map(Number);
    const shifted = values.map((v: number, i: number) => (i % 2 === 0 ? v + dx : v + dy));
    return `${cmd} ${shifted.join(' ')}`;
  });
}
