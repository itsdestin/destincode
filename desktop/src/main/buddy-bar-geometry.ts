import { clampToWorkArea, type Point, type Rect, type Size } from './buddy-window-manager';

// Action bar: three 44×44 buttons + 2 × 8px gaps = 148 wide. main.ts's
// buddyDimensions imports this so the BrowserWindow and the math can't drift.
export const BAR_SIZE: Size = { width: 148, height: 44 };
export const BAR_GAP_PX = 6;

/**
 * Position for the action-bar window — centered horizontally on the mascot,
 * BAR_GAP_PX below it. Flips to above when below would clip the workArea.
 * Always clamped to the visible workArea. Pure — unit-tested.
 * (Extracted from BuddyWindowManager.computeCapturePosition and widened for
 * the 3-button bar.)
 */
export function computeBarPosition(mascotBounds: Rect, workArea: Rect): Point {
  const centerX = mascotBounds.x + Math.round(mascotBounds.width / 2) - Math.round(BAR_SIZE.width / 2);
  const belowY = mascotBounds.y + mascotBounds.height + BAR_GAP_PX;
  const belowFits = belowY + BAR_SIZE.height <= workArea.y + workArea.height;
  const raw = belowFits
    ? { x: centerX, y: belowY }
    : { x: centerX, y: mascotBounds.y - BAR_SIZE.height - BAR_GAP_PX };
  return clampToWorkArea(raw, BAR_SIZE, workArea);
}
