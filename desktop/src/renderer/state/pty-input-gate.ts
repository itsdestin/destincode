import type { SessionChatState } from './chat-types';
import { HISTORY_EXPAND_PROMPT_ID } from './chat-types';

// Shared safety gate for programmatic PTY writes.
//
// Why this module exists (2026-07-09 stray-Enter investigation): while a
// permission request, AskUserQuestion, or plan approval is pending, Claude
// Code's native Ink select menu is LIVE in the PTY at the same time YouCoded
// shows its chat card (the card answers via the hook socket, but the terminal
// menu still listens for keystrokes — that's how PlanApprovalButtons drives
// it with arrow keys). Any byte YouCoded writes to the PTY in that window is
// menu input: a bare `\r` presses Enter on the highlighted option, silently
// auto-answering the question or auto-approving the permission.
//
// Every AUTOMATED PTY writer (submit-retry nudge, chat sends, command sends)
// must consult these predicates first. Deliberate menu-driving writes
// (ToolCard plan keys, TrustGate buttons, terminal-view keystrokes) must NOT
// go through this gate — driving the menu is their whole purpose.

/**
 * True when the session very likely has a live Ink select menu in its PTY:
 * a current-turn tool awaiting approval (permission prompt, AskUserQuestion,
 * ExitPlanMode) or an uncompleted interactive prompt (trust / resume dialogs
 * scraped from the terminal).
 *
 * Scans activeTurnToolIds only — toolCalls is a session-lifetime Map that
 * keeps stale awaiting-approval entries from ended turns.
 */
export function hasPendingInteraction(session: SessionChatState): boolean {
  for (const id of session.activeTurnToolIds) {
    if (session.toolCalls.get(id)?.status === 'awaiting-approval') return true;
  }
  for (const entry of session.timeline) {
    // The "See previous messages" marker rides the `prompt` kind but is a
    // display affordance, not a live Ink menu — it has no answerable buttons
    // and no keystroke is waiting on it. Counting it here silently locked ALL
    // sends on every resumed session (HISTORY_LOADED pushes it with hasMore),
    // until the user happened to click "See previous messages". Skip it — the
    // renderer already special-cases the same id when rendering. (fix 2026-07-17)
    if (entry.kind === 'prompt'
        && entry.prompt.promptId !== HISTORY_EXPAND_PROMPT_ID
        && !entry.prompt.completed) {
      return true;
    }
  }
  return false;
}

/**
 * True only when the session is observably idle enough that a recovery `\r`
 * (useSubmitConfirmation) cannot land on anything but CC's empty input bar:
 *
 * - attentionState 'ok' — no stuck/died banner. NOTE: 'ok' alone is NOT an
 *   idle signal; it's also the normal state during an active turn (both
 *   'thinking-active' and 'unknown' buffer classes map to 'ok').
 * - no pending interaction — see hasPendingInteraction above.
 * - no running current-turn tools and no in-flight assistant turn
 *   (currentTurnId). Covers CC's queued-message behavior: a message sent
 *   mid-turn is queued and its transcript line (which clears `pending`) only
 *   appears when the queue drains, so the retry must wait for turn end —
 *   at which point either the queued message submitted (pending cleared, no
 *   retry) or the send was truly lost (retry is safe).
 *
 * isThinking is deliberately NOT consulted: it is set on USER_PROMPT and only
 * cleared by endTurn(), so in the lost-message state this gate exists to
 * recover from, isThinking stays true forever.
 */
export function canRetrySubmit(session: SessionChatState): boolean {
  if (session.attentionState !== 'ok') return false;
  if (session.currentTurnId !== null) return false;
  for (const id of session.activeTurnToolIds) {
    const status = session.toolCalls.get(id)?.status;
    if (status === 'running' || status === 'awaiting-approval') return false;
  }
  return !hasPendingInteraction(session);
}
