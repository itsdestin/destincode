import { Button } from './ui/Button';

interface StopButtonProps {
  sessionId: string;
  /** Same provider union ChatView threads down — determines which IPC call
   *  actually interrupts the turn. */
  provider?: 'claude' | 'native';
  /** Caller-computed visibility. ChatView passes `thinkingArea &&
   *  state.attentionState === 'ok'` — the exact same guard that decides
   *  whether the ThinkingIndicator (or the native cold-load "Loading…" text)
   *  renders, so the stop control only ever appears while a turn is both
   *  in flight AND healthy. Extracted as a prop (rather than computed here)
   *  so this component stays a pure function of its inputs and is testable
   *  without mounting ChatView's provider tree. */
  visible: boolean;
}

/**
 * Visible interrupt control for a streaming turn.
 *
 * Before this, ESC was the ONLY way to interrupt a turn (App.tsx's global
 * keydown handler) — no affordance existed for touch/phone-remote users, who
 * have no ESC key. This gives them one.
 *
 * Click behavior mirrors the ESC handler exactly (App.tsx ~2305-2315): native
 * sessions have no PTY, so interrupt the in-process harness stream directly;
 * Claude Code sessions get the same single ESC byte the physical key sends.
 */
export default function StopButton({ sessionId, provider, visible }: StopButtonProps) {
  if (!visible) return null;
  return (
    <Button
      size="icon"
      aria-label="Stop generating"
      onClick={() => {
        if (provider === 'native') window.claude.native.interrupt(sessionId);
        else window.claude.session.sendInput(sessionId, '\x1b');
      }}
      className="shrink-0"
    >
      {/* Square stop glyph, currentColor — same inline-svg-in-Button pattern
          as the send button's arrow (InputBar.tsx). */}
      <svg className="w-3 h-3 text-on-accent" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="6" width="12" height="12" rx="1.5" />
      </svg>
    </Button>
  );
}
