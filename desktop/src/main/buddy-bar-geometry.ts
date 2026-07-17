import { clampToWorkArea, type Point, type Rect, type Size } from './buddy-window-manager';

// Every buddy window's size lives here, and main.ts's buddyDimensions imports
// them, so the BrowserWindows and the positioning math can't drift apart.

// Visible action-bar row: three 44×44 buttons + 2 × 8px gaps = 148 wide.
export const BAR_CONTENT: Size = { width: 148, height: 44 };
// The bar WINDOW is padded around that row. The window used to be exactly
// button-height, which was fine while the buttons were inert — but they now
// scale on hover (and overshoot on pop-in), and a button growing past 1.0
// inside a content-sized window clips against the frame (Destin 2026-07-17).
export const BAR_PADDING = 8;
export const BAR_SIZE: Size = {
  width: BAR_CONTENT.width + BAR_PADDING * 2,
  height: BAR_CONTENT.height + BAR_PADDING * 2,
};
export const BAR_GAP_PX = 6;

// 112 (was 80): Destin's 2026-07-16 dev test — the buddy read too small.
export const MASCOT_SIZE: Size = { width: 112, height: 112 };
export const CHAT_SIZE: Size = { width: 320, height: 480 };
// Mascot↔chat gap. Was 12 — halved per Destin (2026-07-16).
export const CHAT_GAP_PX = 6;

/**
 * Where the rig's hands sit, as a fraction of the mascot window's height.
 *
 * The canonical capsule rig (wecoded-themes/mascots/README.md) uses
 * viewBox="-3 -5 30 30" and draws arms hanging from y=9 to y=13; POSES.idle
 * drops them a further 0.5, so the mitten spans y≈11.5..13.5 and centres at
 * ≈12.5 — which is (12.5 + 5) / 30 ≈ 0.583 of the window height, a little
 * below the mascot's midline. Destin wants the action bar's row lined up with
 * the hands rather than the midline (2026-07-17).
 */
export const HANDS_CENTER_FRACTION = 0.583;

/**
 * The VISIBLE button row's rect — beside the mascot, vertically centred on its
 * hands, preferring the right and flipping left when the right would clip.
 * The bar window sits BAR_PADDING outside this on every side; positioning math
 * works in content space so the padding can change without moving the buttons.
 * Pure — unit-tested.
 */
export function computeBarContentRect(mascotBounds: Rect, workArea: Rect): Rect {
  const handsY = mascotBounds.y + Math.round(mascotBounds.height * HANDS_CENTER_FRACTION);
  const y = handsY - Math.round(BAR_CONTENT.height / 2);
  const rightX = mascotBounds.x + mascotBounds.width + BAR_GAP_PX;
  // The window, not just the row, has to clear the workArea edge.
  const rightFits = rightX + BAR_CONTENT.width + BAR_PADDING <= workArea.x + workArea.width;
  const x = rightFits ? rightX : mascotBounds.x - BAR_CONTENT.width - BAR_GAP_PX;
  return { x, y, width: BAR_CONTENT.width, height: BAR_CONTENT.height };
}

/** Bar WINDOW position (the content rect grown by BAR_PADDING), clamped. */
export function computeBarPosition(mascotBounds: Rect, workArea: Rect): Point {
  const c = computeBarContentRect(mascotBounds, workArea);
  return clampToWorkArea({ x: c.x - BAR_PADDING, y: c.y - BAR_PADDING }, BAR_SIZE, workArea);
}

export interface GroupLayout {
  /** Where the mascot should sit — usually unchanged, but see the squash tier. */
  mascot: Point;
  /** Where the chat should sit relative to that mascot position. */
  chat: Point;
}

/**
 * Lay out the buddy group (mascot + chat) for a given mascot rect.
 *
 *   1. Chat BELOW the mascot+bar group, centred on the group's visible span.
 *   2. Chat ABOVE, when it won't fit below. The horizontal relationship is
 *      pinned — above/below is the only flip (Destin 2026-07-16).
 *   3. SQUASHED: when neither fits, bounce the chat away from whichever edge
 *      the mascot is nearest, pin it fully on-screen, and PUSH THE MASCOT back
 *      to the pinned CHAT_GAP_PX so the two stay a rigid unit (Destin 2026-07-17).
 *
 * Tier 3 exists because the group needs CHAT_SIZE.height + CHAT_GAP_PX +
 * mascot height = 598px of vertical room. Below only fits when mascot.y ≤
 * waH−598; above only fits when mascot.y ≥ 486. When waH−598 < 486 every
 * position between is homeless — Destin's 1440×852 (a 2880×1800 panel at 200%
 * scale) leaves a 232px band straight through the middle of the screen.
 *
 * The original code had no tier 3 and simply clamped the chat on-screen, which
 * parked a 480-tall panel over the mascot and made him unclickable. A first fix
 * put the chat BESIDE the mascot there, but that broke the pinned horizontal
 * relationship; moving the mascot instead keeps the group rigid, which is what
 * the pinning was for. The chat is the thing that can't move freely (it's big
 * and must stay readable); the mascot is small and cheap to nudge.
 *
 * The tier-3 result is a FIXED POINT: feeding the returned mascot position back
 * in yields the same layout with no further correction, so callers can apply it
 * without oscillating.
 *
 * Pure — unit-tested, including "the chat never covers the mascot".
 */
export function computeGroupLayout(mascotBounds: Rect, workArea: Rect): GroupLayout {
  const bar = computeBarContentRect(mascotBounds, workArea);
  const groupLeft = Math.min(mascotBounds.x, bar.x);
  const groupRight = Math.max(mascotBounds.x + mascotBounds.width, bar.x + bar.width);
  // +10: nudged right of true group centre per Destin's eye (2026-07-16).
  const x = Math.round((groupLeft + groupRight) / 2) - Math.round(CHAT_SIZE.width / 2) + 10;
  const mascot: Point = { x: mascotBounds.x, y: mascotBounds.y };

  const belowY = mascotBounds.y + mascotBounds.height + CHAT_GAP_PX;
  if (belowY + CHAT_SIZE.height <= workArea.y + workArea.height) {
    return { mascot, chat: clampToWorkArea({ x, y: belowY }, CHAT_SIZE, workArea) };
  }
  const aboveY = mascotBounds.y - CHAT_SIZE.height - CHAT_GAP_PX;
  if (aboveY >= workArea.y) {
    return { mascot, chat: clampToWorkArea({ x, y: aboveY }, CHAT_SIZE, workArea) };
  }

  // Tier 3. Bounce away from the nearer edge: a mascot low on the screen sends
  // the chat up, a mascot high on the screen sends it down. That also happens to
  // be the choice that moves the mascot the shortest distance.
  const roomAbove = mascotBounds.y - workArea.y;
  const roomBelow = workArea.y + workArea.height - (mascotBounds.y + mascotBounds.height);
  const chatGoesAbove = roomAbove >= roomBelow;
  const chatY = chatGoesAbove ? workArea.y : workArea.y + workArea.height - CHAT_SIZE.height;
  const mascotY = chatGoesAbove
    ? chatY + CHAT_SIZE.height + CHAT_GAP_PX
    : chatY - CHAT_GAP_PX - mascotBounds.height;
  const mascotSize: Size = { width: mascotBounds.width, height: mascotBounds.height };
  return {
    mascot: clampToWorkArea({ x: mascotBounds.x, y: mascotY }, mascotSize, workArea),
    chat: clampToWorkArea({ x, y: chatY }, CHAT_SIZE, workArea),
  };
}
