// Session-so-far totals for the active session (spec §2). Sibling of
// useNativeSessionUsage, which returns the LAST TURN's usage and still feeds the
// context and speed chips — those two measure a moment, these measure a session.
// Keeping them separate is deliberate: merging them would force one of the two
// meanings onto chips that need the other.
//
// Snapshot stability: getSnapshot returns the totals object OWNED by the chat
// store, never one built here, so repeated calls return the same reference until
// the reducer replaces it — the requirement useSyncExternalStore imposes.
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { useChatStore } from '../state/chat-context';
import type { SessionTotals } from '../state/session-totals';

export function useNativeSessionTotals(sessionId: string | null): SessionTotals | null {
  const store = useChatStore();
  // Render-phase mirror so getSnapshot sees the current sessionId on the very
  // render that switches sessions (R8 pattern — same as useNativeSessionUsage).
  const sidRef = useRef(sessionId);
  sidRef.current = sessionId;

  const getSnapshot = useCallback((): SessionTotals | null => {
    const sid = sidRef.current;
    if (!sid) return null;
    return store.getState().get(sid)?.totals ?? null;
  }, [store]);

  const subscribe = useCallback((cb: () => void) => store.subscribeAll(cb), [store]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
