import { useEffect, useState } from 'react';
import type { ChromeRect } from '../components/theme-effects-mask';

// CSS classes of the always-on glassmorphism chrome panels. These are the
// elements whose backdrop-filter cost we want to make static. Dynamic
// overlays (.settings-drawer, .layer-surface popups) are intentionally
// excluded — masking them would require tracking show/hide/animate state
// and is not worth the complexity. Cost while a popup is open is a
// known, accepted trade-off documented in the plan.
const CHROME_SELECTORS = ['.header-bar', '.status-bar', '.input-bar-container'];

export function useChromeGeometry(): ChromeRect[] {
  const [rects, setRects] = useState<ChromeRect[]>([]);

  useEffect(() => {
    const elements = CHROME_SELECTORS
      .map((sel) => document.querySelector(sel))
      .filter((el): el is Element => el !== null);

    if (elements.length === 0) {
      setRects([]);
      return;
    }

    const measure = () => {
      const next = elements.map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      });
      setRects(next);
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

  return rects;
}
