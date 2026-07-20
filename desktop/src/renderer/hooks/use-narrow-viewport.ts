// Matches Tailwind's sm: boundary at 640px. Returned boolean is true when the
// viewport is < 640px. Single source of truth for the marketplace mobile
// breakpoint — used wherever the DOM structure (not just classes) needs to
// branch between the wide and narrow layouts.

import { useEffect, useState } from 'react';

const QUERY = '(max-width: 639.98px)';

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
    const mql = window.matchMedia(QUERY);
    setNarrow(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return narrow;
}
