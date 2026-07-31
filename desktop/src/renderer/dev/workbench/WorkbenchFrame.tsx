import React from 'react';
import { WorkbenchToolbar } from './WorkbenchToolbar';
import { getLatency } from './mock-shim';

// The real breakpoint is 639.98px (use-narrow-viewport.ts). 390 is a phone
// width comfortably inside it — not a new breakpoint number, just a width to
// sit below the existing one.
const NARROW_WIDTH = 390;

/**
 * Workbench chrome + the app under review.
 *
 * WHY AN IFRAME rather than rendering <App/> into a width-constrained div:
 * `useNarrowViewport()` (the app's single source of truth for the narrow
 * layout) is `window.matchMedia('(max-width: 639.98px)')` — it measures the
 * VIEWPORT, not its container. Shrinking a wrapper div therefore changes what
 * `packSessions()` measures via clientWidth but leaves every media-query-driven
 * layout in its wide form, so a "narrow" toggle would move the frame without
 * ever activating the narrow UI. That is a silently wrong control, which is
 * worse than no control.
 *
 * An iframe has its own `window`, so matchMedia and clientWidth agree and the
 * narrow layout is the real one. It also means the app boots exactly as it does
 * standalone — same entry, same provider tree, same anti-FOUC ordering.
 *
 * Both mock controls ride on the iframe's URL (`scenario`, `latency`) because
 * the shim reads them from the query string at module init, and the iframe gets
 * its own module instance — a parent-side setLatency() call would not reach it.
 */
export function WorkbenchFrame() {
  const [narrow, setNarrow] = React.useState(false);
  const [view, setView] = React.useState(
    () => new URLSearchParams(location.search).get('view') ?? 'app',
  );

  // Carry the parent's current settings into the child so a reload of the
  // workbench keeps them, and so the child never re-renders the frame (child=1
  // routes it straight to the app or the gallery).
  const src = React.useMemo(() => {
    const params = new URLSearchParams(location.search);
    const child = new URLSearchParams();
    child.set('mode', 'workbench');
    child.set('child', '1');
    child.set('view', view);
    child.set('scenario', params.get('scenario') ?? 'default');
    child.set('latency', String(getLatency()));
    // Forward every design-variant param (utils/design-variant.ts reads them
    // from the iframe's own query string, not the parent's).
    params.forEach((value, key) => { if (key.startsWith('dv_')) child.set(key, value); });
    return `${location.pathname}?${child.toString()}`;
  }, [view]);

  return (
    <div className="h-screen w-screen flex flex-col bg-well">
      <WorkbenchToolbar
        narrow={narrow}
        onNarrow={setNarrow}
        view={view}
        onView={setView}
      />
      <div className="flex-1 min-h-0 flex justify-center overflow-hidden">
        <iframe
          // Remounting on width change is deliberate: the app reads the viewport
          // on FIRST render (use-narrow-viewport.ts's lazy useState), so a live
          // resize would leave first-paint decisions made at the old width.
          // `view` is in the key too so switching surface remounts cleanly.
          key={`${view}-${narrow ? 'narrow' : 'wide'}`}
          title="YouCoded (workbench)"
          src={src}
          className="h-full border-0 bg-canvas"
          style={{ width: narrow ? NARROW_WIDTH : '100%' }}
        />
      </div>
    </div>
  );
}
