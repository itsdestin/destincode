import { useCallback } from 'react';
import { useSyncExternalStore } from 'react';
import { useChatStore } from '../state/chat-context';

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
    return session.isThinking && session.attentionState === 'ok';
  }, [store, sessionId]);

  const subscribe = useCallback(
    (cb: () => void) => store.subscribeSession(sessionId, cb),
    [store, sessionId],
  );

  return useSyncExternalStore(subscribe, getSnapshot);
}
