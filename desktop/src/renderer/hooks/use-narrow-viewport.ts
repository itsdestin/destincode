// Matches Tailwind's sm: boundary at 640px. Returned boolean is true when the
// viewport is < 640px. Single source of truth for the marketplace mobile
// breakpoint — used wherever the DOM structure (not just classes) needs to
// branch between the wide and narrow layouts.

import { useEffect, useState } from 'react';

// Exported so call sites that need the raw media query string (rather than a
// hook subscription — e.g. a one-shot window.matchMedia check in App.tsx)
// don't hardcode a second copy that can drift from this one.
export const NARROW_VIEWPORT_QUERY = '(max-width: 639.98px)';
const QUERY = NARROW_VIEWPORT_QUERY;

export function useNarrowViewport(): boolean {
  // Read the real viewport on the FIRST render, not in the mount effect. This
  // renderer never server-renders (Electron + the Android WebView both load a
  // client bundle), so there's no hydration mismatch to avoid — and starting
  // at `false` made the header paint the wide layout for one frame before
  // collapsing to the ||| menu, a visible flash on every phone launch.
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.(QUERY).matches,
  );
  useEffect(() => {
    // Guarded the same way the initial state above already is. The two lines
    // disagreed: the initial read used `matchMedia?.` while the effect called
    // it outright, so any host without matchMedia (jsdom) survived the first
    // render and then threw on the effect — one file, one API, two assumptions.
    const mql = window.matchMedia?.(QUERY);
    if (!mql) return;
    setNarrow(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return narrow;
}
