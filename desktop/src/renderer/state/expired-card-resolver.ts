import type { SessionChatState } from './chat-types';

/** §2 standing rule (2026-07-30 spec): a card retained by a 'hook-closed'
 *  expiry resolves only after the Ink menu has been ABSENT from the visible
 *  buffer for TWO consecutive flushes. One flush is a race in both
 *  directions: a terminal answer's socket-close often lands BEFORE the flush
 *  that removes the menu (would false-retain, self-heals here), and CC's own
 *  fallback menu renders a beat AFTER a hook kill (a one-shot parse would
 *  false-RESOLVE — clearing the red dot while the session is still blocked
 *  on a menu chat view never renders; that is the original reported bug). */
export const MENU_ABSENT_FLUSHES_TO_RESOLVE = 2;

/** Ids of tool calls that are a still-live retained card: awaiting-approval
 *  AND expired. Scans the session-lifetime `toolCalls` map (not
 *  `activeTurnToolIds`) because a retained card can outlive the turn it was
 *  asked in — the whole point of retention is that it survives past the
 *  point a normal ask would have resolved. */
export function expiredToolIds(session: SessionChatState): string[] {
  const ids: string[] = [];
  for (const [id, tool] of session.toolCalls) {
    if (tool.status === 'awaiting-approval' && tool.expired) ids.push(id);
  }
  return ids;
}

/** Pure transition for the per-session consecutive-absence counter. Menu
 *  present resets to 0 (self-heals a false retain); menu absent increments,
 *  and resolves once it reaches MENU_ABSENT_FLUSHES_TO_RESOLVE consecutive
 *  absent flushes (guards against a one-shot false resolve — see the
 *  module-level comment above). */
export function nextAbsentCount(
  menuPresent: boolean,
  prevCount: number,
): { count: number; resolve: boolean } {
  if (menuPresent) return { count: 0, resolve: false };
  const count = prevCount + 1;
  return { count, resolve: count >= MENU_ABSENT_FLUSHES_TO_RESOLVE };
}
