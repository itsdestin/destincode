import { useCallback, useRef } from 'react';
import { useSyncExternalStore } from 'react';
import { useChatStore } from '../state/chat-context';
import type { AttentionState } from '../state/chat-types';
import type { SessionStatusColor } from '../components/StatusDot';

export interface SessionAttentionInfo {
  status: SessionStatusColor;
  attentionState: AttentionState;
  awaitingApproval: boolean;
}

// Cached selector over the chat store. Re-renders the host ONLY when some
// session's (status, attentionState, awaitingApproval) triple changes —
// replaces AppInner's whole-map subscription (tranche 1). Derivation logic is
// verbatim from the old sessionStatuses memo (App.tsx) + attention-reporter
// triple; keep the two consumers (HeaderBar dots, attention.report) in sync
// with this ONE computation. Iterates sessions ∪ chatStateMap keys so
// chat-state-only sessions still get reported (status 'gray'), matching the
// old reporter exactly.
export function useSessionAttention(
  sessions: Array<{ id: string }>,
  viewedSessions: Set<string>,
  activeSessionId: string | null,
): Map<string, SessionAttentionInfo> {
  const store = useChatStore();
  const cacheRef = useRef<Map<string, SessionAttentionInfo>>(new Map());
  // Render-phase arg mirror (R8 pattern) so getSnapshot — called by React on
  // subscription ticks AND on ordinary re-renders — always sees current args.
  const argsRef = useRef({ sessions, viewedSessions, activeSessionId });
  argsRef.current = { sessions, viewedSessions, activeSessionId };

  const getSnapshot = useCallback((): Map<string, SessionAttentionInfo> => {
    const { sessions, viewedSessions, activeSessionId } = argsRef.current;
    const state = store.getState();
    const next = new Map<string, SessionAttentionInfo>();

    for (const s of sessions) {
      const chatState = state.get(s.id);
      if (!chatState) {
        next.set(s.id, { status: 'gray', attentionState: 'ok', awaitingApproval: false });
        continue;
      }
      // Only check tools in the active turn — stale tools from old turns are invisible
      let hasAwaiting = false;
      let hasRunning = false;
      for (const id of chatState.activeTurnToolIds) {
        const t = chatState.toolCalls.get(id);
        if (!t) continue;
        if (t.status === 'awaiting-approval') hasAwaiting = true;
        else if (t.status === 'running') hasRunning = true;
        if (hasAwaiting) break;
      }
      // Priority chain verbatim from the old memo (red → amber → green → blue → gray)
      const needsAttention = chatState.attentionState !== 'ok';
      const status: SessionStatusColor = hasAwaiting ? 'red'
        : needsAttention ? 'amber'
        : (chatState.isThinking || hasRunning) ? 'green'
        : (chatState.timeline.length > 0 && !viewedSessions.has(s.id) && s.id !== activeSessionId) ? 'blue'
        : 'gray';
      next.set(s.id, { status, attentionState: chatState.attentionState, awaitingApproval: hasAwaiting });
    }
    // Sessions present in chat state but not in the sessions list: the old
    // reporter still reported them (dot fallback 'gray') — preserve that.
    for (const [sid, chatState] of state) {
      if (next.has(sid)) continue;
      let awaitingApproval = false;
      for (const id of chatState.activeTurnToolIds) {
        const t = chatState.toolCalls.get(id);
        if (t?.status === 'awaiting-approval') { awaitingApproval = true; break; }
      }
      next.set(sid, { status: 'gray', attentionState: chatState.attentionState, awaitingApproval });
    }

    // Identity stabilization: return the previous Map when nothing changed.
    const prev = cacheRef.current;
    if (prev.size === next.size) {
      let changed = false;
      for (const [id, info] of next) {
        const p = prev.get(id);
        if (!p || p.status !== info.status || p.attentionState !== info.attentionState || p.awaitingApproval !== info.awaitingApproval) {
          changed = true; break;
        }
      }
      if (!changed) return prev;
    }
    cacheRef.current = next;
    return next;
  }, [store]);

  const subscribe = useCallback((cb: () => void) => store.subscribeAll(cb), [store]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
