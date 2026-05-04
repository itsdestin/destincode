import { useEffect, useRef, useState } from 'react';
import type { ChromeRect } from '../components/theme-effects-mask';

// CSS classes of the always-on glassmorphism chrome panels. These are the
// elements whose backdrop-filter cost we want to make static. Dynamic
// overlays (.settings-drawer, .layer-surface popups) are intentionally
// excluded — masking them would require tracking show/hide/animate state
// and is not worth the complexity. Cost while a popup is open is a
// known, accepted trade-off documented in the plan.
const CHROME_SELECTORS = ['.header-bar', '.status-bar', '.input-bar-container'];

export function useChromeGeometry(): ChromeRect[] {
  // rectsRef holds the live data; we mutate its items in-place so callers
  // that hold a reference (e.g. test code reading result.current after a
  // ResizeObserver trigger without wrapping in act()) always see fresh values.
  const rectsRef = useRef<ChromeRect[]>([]);
  const [, setVersion] = useState(0);

  useEffect(() => {
    const elements = CHROME_SELECTORS
      .map((sel) => document.querySelector(sel))
      .filter((el): el is Element => el !== null);

    if (elements.length === 0) {
      rectsRef.current = [];
      return;
    }

    const measure = () => {
      elements.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const next = { left: r.left, top: r.top, width: r.width, height: r.height };
        if (i < rectsRef.current.length) {
          // Mutate in-place so any held reference reflects the new value
          // immediately — even before React flushes the re-render triggered
          // by setVersion below.
          Object.assign(rectsRef.current[i], next);
        } else {
          rectsRef.current.push(next);
        }
      });
      // Trim if elements were removed.
      rectsRef.current.length = elements.length;
      // Trigger a re-render so React picks up the latest ref values.
      setVersion((v) => v + 1);
    };

    // Synchronous initial measurement avoids a frame where the canvas is
    // unmasked while React is still scheduling the first observer callback.
    measure();

    const observer = new ResizeObserver(measure);
    elements.forEach((el) => observer.observe(el));
    window.addEventListener('resize', measure);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  return rectsRef.current;
}
