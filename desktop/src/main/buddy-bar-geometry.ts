import { clampToWorkArea, type Point, type Rect, type Size } from './buddy-window-manager';

// Action bar: three 44×44 buttons + 2 × 8px gaps = 148 wide. main.ts's
// buddyDimensions imports this so the BrowserWindow and the math can't drift.
export const BAR_SIZE: Size = { width: 148, height: 44 };
export const BAR_GAP_PX = 6;

/**
 * Position for the action-bar window — BESIDE the mascot (vertically
 * centered on it), preferring the right side and flipping to the left when
 * the right would clip the workArea. Always clamped to the visible workArea.
 * Pure — unit-tested.
 * (Was below/above the mascot; moved beside per Destin's 2026-07-16 dev
 * test — the bar under the floater fought the chat window's new home.)
 */
export function computeBarPosition(mascotBounds: Rect, workArea: Rect): Point {
  const centerY = mascotBounds.y + Math.round(mascotBounds.height / 2) - Math.round(BAR_SIZE.height / 2);
  const rightX = mascotBounds.x + mascotBounds.width + BAR_GAP_PX;
  const rightFits = rightX + BAR_SIZE.width <= workArea.x + workArea.width;
  const raw = rightFits
    ? { x: rightX, y: centerY }
    : { x: mascotBounds.x - BAR_SIZE.width - BAR_GAP_PX, y: centerY };
  return clampToWorkArea(raw, BAR_SIZE, workArea);
}
