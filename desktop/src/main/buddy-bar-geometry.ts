import { clampToWorkArea, type Point, type Rect, type Size } from './buddy-window-manager';

// Every buddy window's size lives here, and main.ts's buddyDimensions imports
// them, so the BrowserWindows and the positioning math can't drift apart.
// Action bar: three 44×44 buttons + 2 × 8px gaps = 148 wide.
export const BAR_SIZE: Size = { width: 148, height: 44 };
export const BAR_GAP_PX = 6;
// 112 (was 80): Destin's 2026-07-16 dev test — the buddy read too small.
export const MASCOT_SIZE: Size = { width: 112, height: 112 };
export const CHAT_SIZE: Size = { width: 320, height: 480 };
// Mascot↔chat gap. Was 12 — halved per Destin (2026-07-16).
export const CHAT_GAP_PX = 6;

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

/**
 * Position for the chat window relative to the mascot. Preference ladder:
 *
 *   1. BELOW the mascot+bar group, centered on the group's span.
 *   2. ABOVE, when the chat won't fit below. The horizontal relationship is
 *      pinned — above/below is the only flip (Destin 2026-07-16).
 *   3. BESIDE, opposite the bar, when NEITHER vertical slot fits.
 *
 * Tier 3 isn't a style choice, it's forced by geometry. The chat needs
 * CHAT_SIZE.height + CHAT_GAP_PX + mascot height = 598px of vertical room, so
 * on a short workArea there's a BAND of mascot positions where neither above
 * nor below fits: below needs mascot.y ≤ waH−598, above needs mascot.y ≥ 486,
 * and when waH−598 < 486 everything between is homeless. Destin's 1440×852
 * (a 2880×1800 panel at 200% scale) leaves a 232px band straight through the
 * middle of the screen.
 *
 * The old code had no tier 3 — it just clamped the chat into the workArea,
 * which parked a 480-tall panel at y=0 directly ON TOP of a mascot sitting at
 * y=370, covering him completely. You couldn't click the buddy to close the
 * chat you'd just opened (Destin, 2026-07-16). Beside always fits where the
 * vertical slots don't: the chat is 320 wide in a 1440-wide space.
 *
 * Pure — unit-tested, including the "never covers the mascot" invariant.
 */
export function computeChatPosition(mascotBounds: Rect, workArea: Rect): Point {
  const barPos = computeBarPosition(mascotBounds, workArea);
  const groupLeft = Math.min(mascotBounds.x, barPos.x);
  const groupRight = Math.max(mascotBounds.x + mascotBounds.width, barPos.x + BAR_SIZE.width);
  // +10: nudged right of true group center per Destin's eye (2026-07-16).
  const x = Math.round((groupLeft + groupRight) / 2) - Math.round(CHAT_SIZE.width / 2) + 10;

  const belowY = mascotBounds.y + mascotBounds.height + CHAT_GAP_PX;
  if (belowY + CHAT_SIZE.height <= workArea.y + workArea.height) {
    return clampToWorkArea({ x, y: belowY }, CHAT_SIZE, workArea);
  }
  const aboveY = mascotBounds.y - CHAT_SIZE.height - CHAT_GAP_PX;
  if (aboveY >= workArea.y) {
    return clampToWorkArea({ x, y: aboveY }, CHAT_SIZE, workArea);
  }

  // Tier 3: beside, on whichever side the bar isn't occupying, vertically
  // centered on the mascot. Falls back to the bar's side if the preferred one
  // would clip (mascot hugging a left/right edge).
  const centerY = mascotBounds.y + Math.round(mascotBounds.height / 2) - Math.round(CHAT_SIZE.height / 2);
  const leftX = groupLeft - CHAT_GAP_PX - CHAT_SIZE.width;
  const rightX = groupRight + CHAT_GAP_PX;
  const barIsRight = barPos.x > mascotBounds.x;
  const preferredX = barIsRight ? leftX : rightX;
  const otherX = barIsRight ? rightX : leftX;
  const fitsX = (cx: number) => cx >= workArea.x && cx + CHAT_SIZE.width <= workArea.x + workArea.width;
  const chosenX = fitsX(preferredX) ? preferredX : fitsX(otherX) ? otherX : preferredX;
  return clampToWorkArea({ x: chosenX, y: centerY }, CHAT_SIZE, workArea);
}
