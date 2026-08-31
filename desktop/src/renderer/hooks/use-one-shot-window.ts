// True for one animation window after `key` changes — and never on mount.
//
// Two callers, one shape:
//   • SessionStrip arms the active pill's expand animation when the active
//     session id changes (its label transition is otherwise switched off).
//   • ChatView animates the incoming conversation when its pane becomes the
//     active session.
//
// WHY never on mount: at app start the active session's pill and pane render
// immediately. Firing there would make every cold launch look like a session
// switch that never happened.
//
// WHY no direction option: the hook opens on ANY change of `key`, both ways. A
// caller that wants one direction ANDs in the state it cares about —
// `useOneShotWindow(sessionActive) && sessionActive` is true only on the way
// IN, because on the way OUT the window opens while `sessionActive` is false.
// That is one word at the call site, versus a `direction: 'rising'` option
// nobody could read at a glance.
import { useEffect, useRef, useState } from 'react';

/** 200ms reveal / 240ms switch, plus a frame of slack — one number, because the
 *  strip and the transcript are meant to read as one decision, not two. */
export const MOTION_WINDOW_MS = 240;

export function useOneShotWindow(key: unknown, durationMs = MOTION_WINDOW_MS): boolean {
  const [open, setOpen] = useState(false);
  const prev = useRef(key);

  useEffect(() => {
    // Unchanged key: return WITHOUT a cleanup, so a window already counting
    // down is left alone rather than cancelled by an unrelated re-render.
    if (prev.current === key) return;
    prev.current = key;
    setOpen(true);
    const t = setTimeout(() => setOpen(false), durationMs);
    return () => clearTimeout(t);
  }, [key, durationMs]);

  return open;
}
