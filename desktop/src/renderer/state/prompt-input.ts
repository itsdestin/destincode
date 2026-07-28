import type { PromptButton } from '../parser/ink-select-parser';

// The one way YouCoded answers a Claude Code Ink select menu (trust dialog,
// Resume Session, theme/login pickers, usage-limit menu…). Every PromptCard /
// TrustGate button click funnels through here.
//
// This is a DELIBERATE menu-driving write, so it must NOT go through
// pty-input-gate.ts — driving the live menu is the whole point (see that
// module's header).
//
// Why a helper at all: a button may need TWO writes. Arrow keys and `\r` in the
// same pty write are not both honoured — CC discards the arrows and acts on the
// Enter alone, confirming whatever option is highlighted (measured against CC
// 2.1.220 on 2026-07-26; see menuToButtons for the numbers). Buttons built from
// a numbered menu type a bare digit and need no submit at all; only the
// no-digit fallback carries `submitInput`.

/** Gap between the navigation write and the submit write. Verified at this value
 *  against CC 2.1.220 on 2026-07-26: `UP×5 + DOWN×N` as one write, then `\r` 150ms
 *  later, committed exactly the option N arrow-steps away (for N = 1,2,3) — the
 *  same sequence in ONE write commits the option that was already highlighted. */
export const PROMPT_SUBMIT_DELAY_MS = 150;

export function sendPromptInput(sessionId: string, button: PromptButton): void {
  const session = (window as any).claude?.session;
  if (!session?.sendInput) return;
  session.sendInput(sessionId, button.input);
  if (button.submitInput) {
    const submit = button.submitInput;
    setTimeout(() => session.sendInput(sessionId, submit), PROMPT_SUBMIT_DELAY_MS);
  }
}
