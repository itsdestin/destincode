// Pure geometry for the artifact viewer's zoom and pan. Deliberately DOM-free:
// jsdom reports every getBoundingClientRect as zeros, so anything measured from
// the DOM is untestable. Callers pass sizes in; these functions decide.

/** The rungs the +/- buttons walk, as scale factors (1 = 100%).
 *
 *  12.5 and 25 exist for the FIRST press. A large picture fits at 10-20%, and a
 *  ladder starting at 50% meant one press made it four times bigger — reported
 *  as the steps feeling "weird and inconsistent". These are deliberately the
 *  familiar round numbers rather than a constant ratio (Destin's call). */
export const ZOOM_RUNGS: readonly number[] = [0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8];

/** A rung this close to the fit scale is not worth a press — it would look like
 *  the button did nothing. 8% is enough to see, small enough that the next rung
 *  is rarely a leap. */
const MIN_STEP_RATIO = 1.08;

export interface Sizes { containerW: number; containerH: number; contentW: number; contentH: number }
export interface Offset { x: number; y: number }

/** Scale at which the content just fits. Mirrors what `max-w-full max-h-full`
 *  already did: it shrinks oversized content and NEVER upscales, so a picture
 *  smaller than the pane fits at 1 (100%), not at some blown-up size. */
export function fitScale(s: Sizes): number {
  if (!(s.contentW > 0) || !(s.contentH > 0) || !(s.containerW > 0) || !(s.containerH > 0)) return 1;
  return Math.min(1, s.containerW / s.contentW, s.containerH / s.contentH);
}

/** The rungs reachable for this file. Rungs at or below fit are dropped —
 *  otherwise a small image (fit === 1) would offer 50% and 75%, which is zooming
 *  out past the pane for no reason, and would leave "−" enabled at the floor. */
export function ladderFor(fit: number): number[] {
  return ZOOM_RUNGS.filter((r) => r > fit * MIN_STEP_RATIO);
}

/** The next stop above or below `scale`. `fit` is the floor AND a stop in its
 *  own right, so a wheel-zoomed off-rung value snaps to its neighbour rather
 *  than jumping across the ladder. */
export function stepScale(scale: number, fit: number, dir: 1 | -1): number {
  const stops = [fit, ...ladderFor(fit)];
  if (dir === 1) return stops.find((s) => s > scale + 1e-6) ?? stops[stops.length - 1];
  const below = stops.filter((s) => s < scale - 1e-6);
  return below.length ? below[below.length - 1] : fit;
}

/** Keep the content overlapping the container. Zoom here is a CSS transform,
 *  which creates NO scroll extent, so this clamp is the only thing stopping a
 *  drag from throwing the picture off-screen with no way to bring it back. */
export function clampOffset(o: Offset, scale: number, s: Sizes): Offset {
  const slackX = Math.max(0, (s.contentW * scale - s.containerW) / 2);
  const slackY = Math.max(0, (s.contentH * scale - s.containerH) / 2);
  return {
    x: noNegZero(Math.max(-slackX, Math.min(slackX, o.x))),
    y: noNegZero(Math.max(-slackY, Math.min(slackY, o.y))),
  };
}

/** Clamping a negative offset to a zero slack yields -0, which is a different
 *  value to 0 for equality checks (and prints as "-0px"). Normalise it once here
 *  so no caller has to know. */
function noNegZero(n: number): number {
  return n === 0 ? 0 : n;
}

/** Zoom so the point under the pointer stays under the pointer — the behaviour
 *  every map and browser has. `anchor` is in container-relative pixels; the
 *  content is centred, so the container's centre is the transform origin. */
export function zoomAtPoint(
  prev: { scale: number; offset: Offset },
  nextScale: number,
  anchor: { x: number; y: number },
  s: Sizes,
): { scale: number; offset: Offset } {
  const cx = s.containerW / 2;
  const cy = s.containerH / 2;
  const ratio = nextScale / prev.scale;
  // Vector from the centre to the anchor in pre-zoom space, re-scaled by the
  // change: whatever was under the cursor keeps its screen position.
  const offset = {
    x: anchor.x - cx - (anchor.x - cx - prev.offset.x) * ratio,
    y: anchor.y - cy - (anchor.y - cy - prev.offset.y) * ratio,
  };
  return { scale: nextScale, offset: clampOffset(offset, nextScale, s) };
}

/** Is this client point inside this rect? The lens lives or dies on this: an
 *  ImageView that answered "here is the picture" regardless of where the cursor
 *  was left the lens visible across the whole pane, including on top of its own
 *  off switch (reported 2026-08-27). */
export function pointInRect(x: number, y: number, r: { left: number; top: number; right: number; bottom: number }): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}
