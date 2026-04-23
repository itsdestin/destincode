import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

// Tracks whether any modal-style overlay is currently covering the terminal.
// Consumed by the Android layout-update IPC reporter so the PassThroughWebView
// knows to stop passing touches through to the native TerminalView while an
// interactive overlay is on top — otherwise taps on a modal button would fall
// through to the terminal instead of hitting the modal.
//
// Only matters on Android (where the terminal is a native view sitting behind
// a transparent WebView). Desktop/remote-browser ignores this context entirely.
type Ctx = {
  blocked: boolean;
  increment: () => void;
  decrement: () => void;
};

const TerminalOverlayCtx = createContext<Ctx>({
  blocked: false,
  increment: () => {},
  decrement: () => {},
});

export function TerminalOverlayProvider({ children }: { children: React.ReactNode }) {
  const [blockCount, setBlockCount] = useState(0);
  const increment = useCallback(() => setBlockCount(c => c + 1), []);
  const decrement = useCallback(() => setBlockCount(c => Math.max(0, c - 1)), []);
  const value = useMemo<Ctx>(
    () => ({ blocked: blockCount > 0, increment, decrement }),
    [blockCount, increment, decrement],
  );
  return <TerminalOverlayCtx.Provider value={value}>{children}</TerminalOverlayCtx.Provider>;
}

// Side-effect hook: any component that renders a scrim/backdrop covering the
// terminal should call this to bump the block counter while mounted. Wired
// into the Scrim primitive so every modal gets it automatically.
export function useTerminalOverlayBlock() {
  const { increment, decrement } = useContext(TerminalOverlayCtx);
  useEffect(() => {
    increment();
    return () => decrement();
  }, [increment, decrement]);
}

export function useTerminalOverlayBlocked(): boolean {
  return useContext(TerminalOverlayCtx).blocked;
}
