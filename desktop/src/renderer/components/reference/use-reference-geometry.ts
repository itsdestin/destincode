import { useCallback, useEffect, useState } from 'react';
import { toBoxes, buildUnionPath } from './reference-geometry';
import type { ReferenceAnchor } from '../../state/reference-context';

/**
 * Live geometry for the traced outline.
 *
 * Re-derives rects from the DOM on every measure pass rather than storing a
 * DOMRect[] snapshot — stored rects go stale the instant the transcript
 * scrolls, the window resizes, or the drawer opens (spec §3.1).
 *
 * Returns an empty path when the source is gone; the overlay falls back to a
 * non-anchored centred card in that case (spec §7).
 */
export function useReferenceGeometry(anchor: ReferenceAnchor | null): { d: string } {
  const [geom, setGeom] = useState<{ d: string }>({ d: '' });

  const measure = useCallback(() => {
    if (!anchor) { setGeom({ d: '' }); return; }
    const host = anchor.host;
    if (!host.isConnected) { setGeom({ d: '' }); return; }

    // Trace the SELECTION when there is one (Destin's 9B call); fall back to
    // the whole host element's box when there isn't — which is exactly the
    // no-selection case that already references the entire message.
    // A live Range re-measures itself as the page scrolls — no stored rects, no
    // DOM mutation. If React ever replaces these nodes the Range yields no rects
    // and we fall through to the whole-host outline, which is the designed
    // fallback (spec 7).
    //
    // The containment check is load-bearing. The withdrawn surroundContents()
    // design REJECTED a selection spanning element boundaries (it throws), so a
    // cross-bubble drag produced a null anchor automatically. cloneRange()
    // accepts it happily, so that signal is gone and we must re-derive it here:
    // a Range escaping its host would otherwise trace an outline around content
    // the reference does not actually cover.
    const inHost = !!anchor.range && host.contains(anchor.range.commonAncestorContainer);
    // Array.from, not a spread: this project's tsconfig lib list is
    // ["ES2022", "DOM"] without "DOM.Iterable", so DOMRectList has no
    // Symbol.iterator in the type system (tsc TS2488) even though it's
    // array-like at runtime. Array.from works off .length/index access
    // instead of iteration, so it needs no lib change. Matches this
    // codebase's existing idiom for DOM collections (see
    // html-inline-assets.ts, MascotRig.tsx).
    const runRects = inHost ? Array.from(anchor.range!.getClientRects()) : [];
    const rects = runRects.length ? runRects : [host.getBoundingClientRect()];

    // Viewport-relative: the trace SVG is position:fixed, so the "host" origin
    // for toBoxes is the viewport itself. Task 8's artifact clip-path also
    // consumes `d` in this same viewport coordinate system (see the WHY
    // comment on ReferenceOverlay.tsx's shiftPath call for how it's
    // re-expressed relative to the clone's own box before use).
    const origin = { left: 0, top: 0 } as DOMRect;
    setGeom({ d: buildUnionPath(toBoxes(rects as DOMRect[], origin)) });
  }, [anchor]);

  useEffect(() => {
    measure();
    if (!anchor) return;
    window.addEventListener('resize', measure);
    // capture:true so scrolling ANY ancestor scroller (chat-scroll, the artifact
    // pane) re-measures — scroll does not bubble.
    window.addEventListener('scroll', measure, true);
    const ro = new ResizeObserver(measure);
    const host = anchor.host;
    if (host) ro.observe(host);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      ro.disconnect();
    };
  }, [anchor, measure]);

  return geom;
}
