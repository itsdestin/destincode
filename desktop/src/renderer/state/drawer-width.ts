// desktop/src/renderer/state/drawer-width.ts
/** Artifact-drawer width preference (youcoded#105).
 *
 * The drawer's width is distributed to the layout through ONE CSS var,
 * `--right-pane-width` (see react-renderer rule — the chrome-glass cutout and
 * .drawer-pane both read it). This module owns the USER-CHOSEN width behind
 * it: `--drawer-width`, set on <html> by ThemeProvider and referenced by
 * App.tsx's inline style as `var(--drawer-width, 480px)`. Live drag writes
 * the <html> var directly (no React re-render per mousemove); pointer-up
 * commits through ThemeProvider (state + localStorage).
 */

export const DRAWER_WIDTH_KEY = 'youcoded-drawer-width';
export const DEFAULT_DRAWER_WIDTH = 480; // matches the pre-resize fixed width
export const MIN_DRAWER_WIDTH = 320;     // thinner is unreadable
export const MAX_DRAWER_FRACTION = 0.6;  // leave the chat pane usable

/** Clamp a candidate width to [320, 60% of window], defaulting to 480 for
 *  non-finite input (e.g. corrupt localStorage). Always returns an integer. */
export function clampDrawerWidth(width: number, windowWidth: number): number {
  if (!Number.isFinite(width)) return DEFAULT_DRAWER_WIDTH;
  const max = Math.max(MIN_DRAWER_WIDTH, Math.floor(windowWidth * MAX_DRAWER_FRACTION));
  return Math.round(Math.min(max, Math.max(MIN_DRAWER_WIDTH, width)));
}

/** Write the live width var on <html>. Used by ThemeProvider (committed
 *  value) AND by the drag handler (per-frame preview). */
export function applyDrawerWidthVar(px: number): void {
  document.documentElement.style.setProperty('--drawer-width', `${px}px`);
}
