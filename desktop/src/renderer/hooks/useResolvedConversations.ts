import { useEffect, useState } from 'react';
import type { ResolvedConversation } from '../../shared/chatsearch-refs';

export interface ResolvedState {
  results: ResolvedConversation[];
  loading: boolean;
  /** true when the backend cannot answer at all (Android stub, IPC error). */
  unavailable: boolean;
}

/**
 * Resolve short ids against the app-owned chatsearch index. The effect keys on
 * the JOINED ids, never the array: the caller re-parses the tool output on
 * every render, so the array identity changes each time — depending on it
 * would cancel the in-flight lookup on every re-render and spin forever.
 *
 * Callers that must obey rules-of-hooks even when they have nothing to
 * resolve yet (e.g. SessionDrawer's preview header, called unconditionally
 * before an early return) pass `[]`. Fix: an empty id list used to still call
 * `chatsearch.resolve([])` — a real IPC round trip for a caller that had
 * nothing to ask. Bail before the effect body runs any async work at all, so
 * an idle drawer with no preview open makes zero chatsearch calls.
 */
export function useResolvedConversations(ids: string[]): ResolvedState {
  const key = ids.join(' ');
  const [state, setState] = useState<ResolvedState>(
    key ? { results: [], loading: true, unavailable: false } : { results: [], loading: false, unavailable: false },
  );
  useEffect(() => {
    if (!key) { setState({ results: [], loading: false, unavailable: false }); return; }
    let cancelled = false;
    setState({ results: [], loading: true, unavailable: false });
    (async () => {
      try {
        const res = await (window.claude as any).chatsearch.resolve(key.split(' '));
        if (cancelled) return;
        setState(res?.ok ? { results: res.results, loading: false, unavailable: false } : { results: [], loading: false, unavailable: true });
      } catch {
        if (!cancelled) setState({ results: [], loading: false, unavailable: true });
      }
    })();
    return () => { cancelled = true; };
  }, [key]);
  return state;
}
