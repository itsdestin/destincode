import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/**
 * The "Ask Claude about this" held reference (spec 2026-07-26).
 *
 * Replaces the v1 approach of pasting a prompt scaffold straight into the
 * composer. The scaffold now lives HERE as `promptText` and is prepended at
 * send time, so the textarea only ever contains the user's own words.
 */
export type ReferenceAnchor = {
  /** CSS selector re-finding the element the reference came from. */
  hostSelector: string;
  /** Selector for the selected runs inside the host, or null for a whole-element reference. */
  runSelector: string | null;
};

export type PendingReference = {
  kind: 'chat-text' | 'chat-code' | 'artifact';
  /** Placeholder copy, ALREADY truncated by the builder. */
  label: string;
  /** Prepended at send. Never rendered in the composer. */
  promptText: string;
  /**
   * How to re-find the source. Selectors, NOT a DOMRect[] snapshot: stored rects
   * go stale the moment the transcript scrolls, the window resizes, or a drawer
   * opens, so geometry is re-derived on every measure pass instead.
   */
  anchor: ReferenceAnchor | null;
};

type ReferenceApi = {
  reference: PendingReference | null;
  setReference: (r: PendingReference | null) => void;
  clearReference: () => void;
};

const ReferenceContext = createContext<ReferenceApi | null>(null);

export function ReferenceProvider({ sessionId, children }: { sessionId: string; children: React.ReactNode }) {
  const [reference, setReferenceState] = useState<PendingReference | null>(null);

  // Per-session parking, mirroring InputBar's draftsRef (InputBar.tsx:132): a held
  // reference belongs to the session it was created in. Without this, switching
  // sessions would silently apply session A's reference to session B's next message.
  const parked = useRef<Map<string, PendingReference>>(new Map());
  const prevSession = useRef(sessionId);

  useEffect(() => {
    const prev = prevSession.current;
    if (prev === sessionId) return;
    // Park the outgoing session's reference, restore the incoming one.
    setReferenceState((current) => {
      if (current) parked.current.set(prev, current);
      else parked.current.delete(prev);
      return parked.current.get(sessionId) ?? null;
    });
    prevSession.current = sessionId;
  }, [sessionId]);

  const setReference = useCallback((r: PendingReference | null) => setReferenceState(r), []);
  const clearReference = useCallback(() => setReferenceState(null), []);

  // Memoized: this context changes only on set/clear, so consumers must not
  // re-render on unrelated parent renders (react-renderer rule).
  const value = useMemo(
    () => ({ reference, setReference, clearReference }),
    [reference, setReference, clearReference],
  );

  return <ReferenceContext.Provider value={value}>{children}</ReferenceContext.Provider>;
}

export function useReference(): ReferenceApi {
  const ctx = useContext(ReferenceContext);
  if (!ctx) throw new Error('useReference must be used inside a ReferenceProvider');
  return ctx;
}
