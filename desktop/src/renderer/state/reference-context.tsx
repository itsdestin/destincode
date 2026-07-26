import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/**
 * The "Ask Claude about this" held reference (spec 2026-07-26).
 *
 * Replaces the v1 approach of pasting a prompt scaffold straight into the
 * composer. The scaffold now lives HERE as `promptText` and is prepended at
 * send time, so the textarea only ever contains the user's own words.
 */
export type ReferenceAnchor = {
  /** The element the reference came from. Held directly — see the note below. */
  host: Element;
  /** Live Range over the selection, or null for a whole-element reference. */
  range: Range | null;
};

export type PendingReference = {
  kind: 'chat-text' | 'chat-code' | 'artifact';
  /** Placeholder copy, ALREADY truncated by the builder. */
  label: string;
  /** Prepended at send. Never rendered in the composer. */
  promptText: string;
  /**
   * Live DOM handles, NOT selectors and NOT a DOMRect[] snapshot. Rects go stale
   * the moment the transcript scrolls, the window resizes, or a drawer opens, so
   * geometry must be re-derived on every measure pass anyway — which only needs
   * a live node, not a selector. Selectors were the original design, but
   * re-finding a host meant tagging it with a `data-reference-host` attribute,
   * and re-finding a selection meant wrapping it in a marker `<span>` via
   * `Range.surroundContents()` — a DOM mutation. Chat bubbles render their text
   * as plain React-managed JSX, so React's fiber still points at the original
   * text node after surroundContents() splits it; the next reconcile throws
   * `NotFoundError: Failed to execute 'removeChild'` and takes down the chat
   * view. Holding the live node/Range instead needs no mutation at all. This is
   * safe only because this state is renderer-local — never serialized,
   * persisted, or sent over IPC.
   */
  anchor: ReferenceAnchor | null;
};

type ReferenceApi = {
  reference: PendingReference | null;
  // Accepts a value OR a React-style updater (prev) => next — the updater form
  // lets callers restore a reference conditionally (e.g. "only if nothing newer
  // was set meanwhile") without a stale-closure read of `reference`. See the
  // native-send-failure restore in InputBar.tsx for the motivating case.
  setReference: (r: PendingReference | null | ((prev: PendingReference | null) => PendingReference | null)) => void;
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

  // Forwards straight to useState's setter, which already accepts both a plain
  // value and an updater function — no extra branching needed here.
  const setReference = useCallback(
    (r: PendingReference | null | ((prev: PendingReference | null) => PendingReference | null)) => setReferenceState(r),
    [],
  );
  const clearReference = useCallback(() => setReferenceState(null), []);

  // Memoized: this context changes only on set/clear, so consumers must not
  // re-render on unrelated parent renders (react-renderer rule).
  const value = useMemo(
    () => ({ reference, setReference, clearReference }),
    [reference, setReference, clearReference],
  );

  return <ReferenceContext.Provider value={value}>{children}</ReferenceContext.Provider>;
}

// Stable inert no-ops shared by every call site missing a provider — same
// module-level singleton per render tree, so they're safe to sit in effect
// dependency arrays (InputBar's minimal-mode clearReference effect) without
// retriggering on every render the way a freshly-allocated `() => {}` would.
const INERT_API: ReferenceApi = {
  reference: null,
  setReference: () => {},
  clearReference: () => {},
};

// Soft-fail when no provider is mounted: the hook becomes a no-op rather than
// throwing. Production always has a ReferenceProvider around InputBar's main-
// app tree, so the real path is always exercised there. The soft-fail exists
// for two other trees that mount InputBar with NO ReferenceProvider ancestor:
// the Buddy companion windows (BuddyChatApp, BuddyOverlayApp — see App.tsx's
// "Buddy windows render as isolated placeholders without main-app providers"
// comment) and isolated component tests. Before this fix, opening the Buddy
// window crashed it blank — useReference() threw on InputBar's very first
// render, with no ErrorBoundary between the buddy early-return and the throw.
// Follows the same pattern as React Router hooks, and the same pattern
// already established by useEscClose (use-esc-close.tsx).
export function useReference(): ReferenceApi {
  const ctx = useContext(ReferenceContext);
  return ctx ?? INERT_API;
}
