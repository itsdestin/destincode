import { useCallback, useRef, useSyncExternalStore } from 'react';
import { useChatStore } from '../state/chat-context';
import type { TurnUsage } from '../state/chat-types';

// Cached selector: the usage stamped on the most recent completed assistant turn
// in the ACTIVE session's timeline (or null — no session, no completed turns, or
// a Claude Code session, whose turns carry no native usage). Feeds the StatusBar
// context / tokens / tokens-per-sec chips (Plan C Task 12).
//
// Why a hook and not a useMemo (merge reconciliation, Plan C × AppInner tranche 1):
// this started life as `useMemo(..., [isNativeSession, sessionId, chatStateMap])`
// inside AppInner. Tranche 1 then deleted the reactive `chatStateMap` value —
// AppInner now holds `chatStateMapRef`, a ref fed by a store subscription,
// precisely so a dispatch no longer re-renders the whole component. A ref can't
// drive a memo (no re-render, so the chips would freeze at their first value), so
// the walk moves here, behind useSyncExternalStore: the host re-renders only when
// THIS session's usage object actually changes identity.
//
// Snapshot stability: getSnapshot must return a referentially stable value or
// React loops. It does — `turn.usage` is an object OWNED by the chat store, not
// constructed here, so repeated calls return the same reference until the reducer
// replaces that turn. (Contrast useSessionAttention, which builds a Map and
// therefore needs its own manual cache.)
//
// v1 timing caveat: native turns stamp usage at turn-complete, so the context
// chip lags during a long turn rather than ticking live. Mid-turn liveness was
// deliberately deferred (Plan C decision 7).
export function useNativeSessionUsage(sessionId: string | null): TurnUsage | null {
  const store = useChatStore();
  // Render-phase mirror so getSnapshot sees the current sessionId on the very
  // render that switches sessions (R8 pattern — same as useActiveSessionModel).
  const sidRef = useRef(sessionId);
  sidRef.current = sessionId;

  const getSnapshot = useCallback((): TurnUsage | null => {
    const sid = sidRef.current;
    if (!sid) return null;
    const session = store.getState().get(sid);
    if (!session) return null;

    // Walk backward for the most recent assistant turn carrying usage. CC
    // sessions never stamp it, so they fall through to null and the chips hide.
    for (let i = session.timeline.length - 1; i >= 0; i--) {
      const entry = session.timeline[i];
      if (entry.kind === 'assistant-turn') {
        const turn = session.assistantTurns.get(entry.turnId);
        if (turn?.usage) return turn.usage;
      }
    }
    return null;
  }, [store]);

  const subscribe = useCallback((cb: () => void) => store.subscribeAll(cb), [store]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
