// True for one animation window after `key` changes — and never on mount.
//
// Two callers, one shape:
//   • SessionStrip arms the pill label transitions when the active session id
//     changes (they are otherwise switched off, so repack churn stays still).
//   • ChatView animates the incoming conversation when its pane becomes the
//     active session.
//
// WHY never on mount: at app start the active session's pill and pane render
// immediately. Firing there would make every cold launch look like a session
// switch that never happened.
//
// WHY the window opens DURING RENDER, not in an effect (2026-09-01 rebuild):
// the first version set `open` from useEffect, which runs after the browser
// has already painted the new state once. For a session switch that meant one
// frame of the incoming conversation fully visible, then the fade-in starting
// from invisible — a flash — whenever the switch was not driven by a click
// (React only flushes effects before paint for discrete input events). Setting
// state while rendering is React's documented pattern for state derived from a
// changed prop: React discards this render and re-runs it immediately with the
// new state, so the FIRST committed frame already carries the window.
//
// WHY no direction option: the hook opens on ANY change of `key`, both ways. A
// caller that wants one direction ANDs in the state it cares about —
// `useOneShotWindow(sessionActive) && sessionActive` is true only on the way
// IN, because on the way OUT the window opens while `sessionActive` is false.
import { useEffect, useState } from 'react';

/** 200ms reveal / 240ms switch, plus a frame of slack — one number, because the
 *  strip and the transcript are meant to read as one decision, not two. */
export const MOTION_WINDOW_MS = 240;

interface Window { key: unknown; open: boolean; gen: number }

export function useOneShotWindow(key: unknown, durationMs = MOTION_WINDOW_MS): boolean {
  const [win, setWin] = useState<Window>({ key, open: false, gen: 0 });

  // Derived state: the key moved since the last render, so open a fresh window
  // (a new `gen`, which is what restarts the clock below on back-to-back changes).
  if (win.key !== key) setWin({ key, open: true, gen: win.gen + 1 });

  useEffect(() => {
    if (!win.open) return;
    const t = setTimeout(() => setWin(w => (w.gen === win.gen ? { ...w, open: false } : w)), durationMs);
    return () => clearTimeout(t);
  }, [win.open, win.gen, durationMs]);

  return win.open;
}
