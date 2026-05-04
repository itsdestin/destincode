// Pure helpers used by ThemeEffects to mask the particle canvas around
// glassmorphism chrome panels (header bar, status bar, input bar). Kept
// pure + free of React/DOM imports so the unit tests can run under jsdom
// without any browser stubs.

export interface ChromeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Builds a CSS `clip-path: path(evenodd, ...)` value that includes the
 *  whole viewport with rectangular holes punched out for each chrome rect.
 *  Even-odd fill rule means the inner subpaths subtract from the outer. */
export function buildChromeClipPath(
  viewport: { width: number; height: number },
  rects: ChromeRect[],
): string {
  if (rects.length === 0) return 'none';
  const outer = `M 0 0 H ${viewport.width} V ${viewport.height} H 0 Z`;
  const holes = rects
    .map(
      (r) =>
        `M ${r.left} ${r.top} H ${r.left + r.width} V ${r.top + r.height} H ${r.left} Z`,
    )
    .join(' ');
  return `path(evenodd, '${outer} ${holes}')`;
}

/** Returns an opacity multiplier in [0, 1] for a particle at (x, y) based
 *  on its distance to the nearest chrome rect.
 *  - 1.0 when the particle is at least `fadeDistance` pixels away from every rect
 *  - 0.0 when the particle is strictly inside any rect
 *  - linear ramp in the fade band between
 *  Used to soften the edge of the canvas clip so particles don't pop at
 *  the masked-rect boundary. */
export function chromeEdgeFalloff(
  x: number,
  y: number,
  rects: ChromeRect[],
  fadeDistance: number,
): number {
  if (rects.length === 0) return 1;
  let minMultiplier = 1;
  for (const r of rects) {
    const right = r.left + r.width;
    const bottom = r.top + r.height;
    // Component distances from the point to the rect — 0 if the point is
    // inside the corresponding axis range, positive if outside.
    const dx = Math.max(r.left - x, 0, x - right);
    const dy = Math.max(r.top - y, 0, y - bottom);
    const outside = Math.sqrt(dx * dx + dy * dy);
    if (outside === 0) return 0; // inside this rect
    if (outside < fadeDistance) {
      const m = outside / fadeDistance;
      if (m < minMultiplier) minMultiplier = m;
    }
  }
  return minMultiplier;
}
