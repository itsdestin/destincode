// Holds the pack result taken at pointer-down for the whole of a drag.
//
// WHY: the strip collapses pills into dots when it runs out of room. Opening a
// slot for the dragged pill makes the row wider, which can trip a repack —
// pills turning into dots UNDER THE CURSOR mid-drag would read as worse than
// the one-frame jump this feature exists to remove. Whatever the row looked
// like when you pressed down is what it looks like until you let go.
//
// This is the second of two freezes, and they do different jobs: SessionStrip's
// pillRectsRef freezes where the pills ARE (so the hit test cannot chase its
// own output); this freezes which pills SHOW THEIR NAMES (so the row cannot
// repack under the cursor).
import { useRef } from 'react';
import type { PackResult } from './pack-sessions';

export function useFrozenPack(live: PackResult, frozen: boolean): PackResult {
  const held = useRef<PackResult | null>(null);

  if (!frozen) {
    held.current = null;
    return live;
  }
  // First render of a frozen period captures; every later one reuses.
  //
  // WHY writing a ref during render is safe HERE, where it usually is not: the
  // write is idempotent (it only ever fills a null slot) and the value it holds
  // is discarded the moment `frozen` goes false. A React double-render or a
  // discarded concurrent render therefore cannot leave a stale value behind —
  // it would capture the same `live` twice, or capture one that is thrown away
  // with the drag. Do NOT extend this to anything that accumulates.
  if (held.current === null) held.current = live;
  return held.current;
}
