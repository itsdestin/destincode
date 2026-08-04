import { useCallback, useEffect, useState, type RefObject } from 'react';
import { toBoxes, mergeAdjacentBoxes, buildRoundedOutlinePath } from './reference-geometry';

// The traced outline is `position:fixed; inset:0` (globals.css), so its own
// coordinate space IS the viewport — no host offset to subtract.
const VIEWPORT_ORIGIN = { left: 0, top: 0 } as DOMRect;

/**
 * Live geometry for the traced outline AND (for artifact references) the
 * clip-path — one measurement, two consumers, so they can never drift apart.
 *
 * Restored 2026-07-28 after a dev-review pass deleted the outline entirely.
 * The ORIGINAL version measured `anchor.range`/`anchor.host` — the SOURCE's
 * position — which is exactly what made the outline "uneven and janky" in a
 * way no amount of geometry smoothing could fix on its own: for a travelling
 * chat reference, the source is the empty space the bubble flew away from,
 * not where the highlighted text actually is. This version anchors to the
 * `<mark class="reference-mark">` elements INSIDE THE CLONE instead — which
 * is wherever the highlight actually is, for BOTH a travelling chat clone and
 * a pinned artifact clone, by construction (it's the clone's own rendered
 * layout, transform included, that getClientRects() reads).
 *
 * `containerRef` is the reference-lift node — stable across the whole
 * held-reference lifetime (see ReferenceOverlay.tsx's liftRef comment on
 * node reuse across reference changes) — so this hook re-queries
 * `.reference-mark` fresh on every measure rather than holding onto element
 * references that go stale when the clone is replaced.
 *
 * No marks (a whole-message/whole-file reference with no partial selection)
 * -> empty `d`, no outline. That case already has its own "this is the
 * reference" signal (the travelling card's own ring, or the artifact clone
 * simply being the whole undimmed clone) — tracing a box around content that
 * already fills the entire clone would just duplicate it, not clarify
 * anything. See the outline-restore report for the fuller reasoning.
 */
export function useReferenceGeometry(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  // Identity of the CURRENT reference. Not read directly — only used to force
  // a fresh measure() when a new reference (and therefore a freshly-cloned
  // set of marks) replaces the old one, since containerRef's own identity
  // never changes (the node is reused, not remounted).
  remeasureKey: unknown,
): { d: string; remeasure: () => void } {
  const [geom, setGeom] = useState<{ d: string }>({ d: '' });

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container || !active) {
      setGeom((g) => (g.d === '' ? g : { d: '' }));
      return;
    }
    const marks = container.querySelectorAll('.reference-mark');
    if (marks.length === 0) {
      setGeom((g) => (g.d === '' ? g : { d: '' }));
      return;
    }
    const rects: DOMRect[] = [];
    marks.forEach((mark) => {
      rects.push(...(Array.from(mark.getClientRects()) as DOMRect[]));
    });
    const boxes = mergeAdjacentBoxes(toBoxes(rects, VIEWPORT_ORIGIN));
    const d = buildRoundedOutlinePath(boxes);
    // Skip the setState when nothing actually changed — the resize/scroll
    // listeners below fire far more often than the geometry actually moves
    // (e.g. a scroll of an unrelated pane), and an unnecessary setState would
    // trigger a re-render (and, transitively, a re-run of the artifact clip
    // effect that depends on `d`) for no visible change.
    setGeom((g) => (g.d === d ? g : { d }));
  }, [containerRef, active]);

  // Baseline: mount-time measure, plus re-measure on window resize and on
  // ANY ancestor scroller scrolling (capture: true — scroll does not
  // bubble), same as the pre-restoration hook. Also re-runs measure() fresh
  // whenever `remeasureKey` (the reference identity) changes, since that's
  // when the clone — and its marks — got replaced.
  useEffect(() => {
    measure();
    // Nothing to listen for without a real node — also keeps this a true
    // no-op (no leaked listeners) when a caller passes `active: true` before
    // its ref has attached, which shouldn't happen in practice (React
    // attaches refs before effects run) but costs nothing to guard.
    if (!active || !containerRef.current) return;
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, remeasureKey, measure]);

  // Track the FLIP travel: `.reference-lift`'s CSS transition (globals.css)
  // fires native `transitionrun`/`transitionend`/`transitioncancel` events on
  // the node whenever its `transform` changes — both the entry glide-to-
  // centre AND the cancel return-trip (ReferenceOverlay.tsx's `beginExit`)
  // just reassign `transform`, so both are covered by the same pair of
  // listeners, with no extra wiring needed at the call site.
  //
  // Deliberately native DOM events, not a React effect keyed on the
  // transform value: this is what guarantees the polling loop below can
  // NEVER touch node.style.transform/left/top itself — it only calls
  // `measure()`, which is local state internal to THIS hook. ReferenceOverlay
  // already carries a hard-won fix for a bug shaped exactly like the one this
  // would reintroduce if `d` leaked into the FLIP effect's own dependency
  // array (see its WHY comment on why the FLIP effect's deps are
  // `[reference, travels]` only, never `d`) — this hook's whole design keeps
  // that boundary intact by construction: geometry-tracking and
  // position-setting are two different effects that share no dependency.
  //
  // Not testable in jsdom (no real CSS transition engine — see the file
  // header on use-reference-geometry.test.ts for what jsdom can and can't
  // prove here); what IS provable, and what the tests below pin, is that the
  // listeners are attached and torn down correctly.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !active) return;
    let rafId: number | null = null;
    const tick = () => {
      measure();
      rafId = window.requestAnimationFrame(tick);
    };
    const start = () => {
      if (rafId === null) tick();
    };
    const stop = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      measure(); // final settle measurement so the outline lands exactly, not one frame stale
    };
    container.addEventListener('transitionrun', start);
    container.addEventListener('transitionend', stop);
    container.addEventListener('transitioncancel', stop);
    return () => {
      container.removeEventListener('transitionrun', start);
      container.removeEventListener('transitionend', stop);
      container.removeEventListener('transitioncancel', stop);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, remeasureKey, measure]);

  // Exposed so ReferenceOverlay's positioning effects can force an immediate
  // re-measure right after they set left/top/transform — belt-and-braces
  // alongside the automatic listeners above, so the FIRST paint after a
  // reference is set (or after the entry FLIP's rAF-deferred "Last" position
  // lands) is correct without waiting on a resize/scroll/transition event
  // that may not come.
  return { d: geom.d, remeasure: measure };
}
