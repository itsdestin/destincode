import { useCallback } from 'react';
import { useSyncExternalStore } from 'react';
import { useChatStore } from '../state/chat-context';
import type { AttentionState } from '../state/chat-types';

// Attention states that mean THE TURN IS OVER. Nothing is generating, so there
// is nothing left to stop and the button must not appear.
//
// Fix (I2, whole-branch review 2026-08-16): this used to be the positive test
// `attentionState === 'ok'`, which was correct only while 'ok' was the only
// state a live native turn could be in. The stall work changed that — the
// 60s warning now sets 'stuck' and the park sets 'stalled', both of them
// states where the turn IS still running — so the square Stop button vanished
// at the 60s mark and stayed gone for the whole countdown. That control exists
// specifically for touch/phone users, who have no ESC key, so the turn became
// un-stoppable at exactly the moment the user most wants to stop it.
//
// WHY an exclusion list and not an allowlist of "still streaming" states: an
// allowlist fails CLOSED — a state added later would silently hide the control
// again, which is the identical bug, and it is invisible (no error, no test,
// just a missing button). The exclusion fails OPEN, toward the user keeping a
// way out. That is safe because `isThinking` below is the real end-of-turn
// guard: both states listed here are only ever set on top of endTurn(), which
// already sets isThinking:false, so this list is belt-and-braces rather than
// the sole gate.
const TURN_IS_OVER = new Set<AttentionState>(['session-died', 'error']);

// Cached per-session selector, same idiom as useSessionAttention.ts (subscribe
// to the store, derive a value in getSnapshot, let useSyncExternalStore gate
// re-renders on the RETURNED value rather than on every dispatch).
//
// Fix (review finding, 2026-07-22, Task 10): InputBar used to read the full
// SessionChatState via useChatState(sessionId) just to compute this one
// boolean. useChatState re-renders on every dispatch for the session — during
// a streaming turn that's every token/tool delta — so the composer (a
// controlled textarea) was re-rendering on state it never displays, purely to
// watch two fields. Unlike useSessionAttention's Map case (which needs an
// explicit cacheRef to avoid a fresh-object-every-call identity break),
// getSnapshot here returns a plain boolean: primitives compare via Object.is
// naturally, so useSyncExternalStore already skips the re-render whenever
// isThinking/attentionState haven't crossed the gate — no extra caching
// needed. subscribeSession (not subscribeAll) further limits notification to
// this one session, same scoping useChatState itself uses.
export function useStreamingGate(sessionId: string): boolean {
  const store = useChatStore();

  const getSnapshot = useCallback((): boolean => {
    const session = store.getSession(sessionId);
    return session.isThinking && !TURN_IS_OVER.has(session.attentionState);
  }, [store, sessionId]);

  const subscribe = useCallback(
    (cb: () => void) => store.subscribeSession(sessionId, cb),
    [store, sessionId],
  );

  return useSyncExternalStore(subscribe, getSnapshot);
}
