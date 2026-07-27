import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Scrim, REFERENCE_COMPOSER_Z } from '../overlays/Overlay';
import { CloseButton } from '../ui/CloseButton';
import { useReference } from '../../state/reference-context';
import { useTheme } from '../../state/theme-context';
import { useEscClose, useEscStackDepth } from '../../hooks/use-esc-close';
import { useReferenceGeometry } from './use-reference-geometry';
import { shiftPath } from './reference-geometry';

/**
 * The held "Ask Claude about this" reference (spec 2026-07-26).
 *
 * One app-wide instance. Owns the window-wide dim; Tasks 7 and 8 add the traced
 * outline and the lifted clone on top of this shell.
 *
 * Window-wide, not pane-scoped — Destin's 10B call: "dim should apply to the
 * whole window so it's obvious what is being highlighted / what the user is
 * asking about." Both the chat and artifact surfaces share this one scrim.
 */
export function ReferenceOverlay() {
  const { reference, clearReference } = useReference();
  // Task 9: reduced-effects fallback — collapses the trace/pulse/glow/travel
  // motion to a static outline. Read here (not derived in globals.css alone)
  // because there's no data-reduced-effects attribute on <html> to key a CSS
  // selector off of (theme-engine.ts only zeroes blur vars for this setting),
  // so the component stamps its own data-reduced flag instead.
  const { reducedEffects } = useTheme();
  const depth = useEscStackDepth();
  const depthAtOpen = useRef<number | null>(null);
  // Task 7: the traced outline around the referenced content. Task 8 also
  // reuses `d` directly for the artifact clip-path (see the lift effect
  // below) — the hook used to return raw `rects` too, for a redraw approach
  // that was dropped in favor of clipping the clone, so that field was
  // deleted as dead code.
  const { d } = useReferenceGeometry(reference?.anchor ?? null);

  // Task 8: chat references lift a clone to the viewport centre; artifact
  // references stay put and get clipped to the selection instead (spec 2.2).
  const travels = reference?.kind === 'chat-text' || reference?.kind === 'chat-code';
  const liftRef = useRef<HTMLDivElement | null>(null);
  const holderRef = useRef<HTMLDivElement | null>(null);

  // Clone the source node ONCE per reference, so the lifted card survives the
  // original unmounting (e.g. the transcript virtualizes it away, or a new
  // turn pushes it out of the rendered window).
  //
  // cloneNode(true), NOT innerHTML: innerHTML would serialise the source to a
  // string and re-parse it, which is both wasted work and an XSS surface;
  // cloneNode copies the live DOM nodes directly, no parsing involved. NOTE
  // this does NOT mean everything about the source comes across — a <canvas>'s
  // drawn bitmap is GPU/raster state, not a DOM attribute, so cloning one
  // yields a blank canvas; likewise scrollTop/scrollLeft on a scrolled
  // descendant are runtime state that cloneNode does not copy (the clone
  // reads scrollTop 0). Neither matters TODAY — the app's one <canvas> is an
  // unrelated background layer, not referenceable content — but a future
  // reference source with either will need more than cloneNode to snapshot
  // faithfully.
  //
  // The clone is a static snapshot — safe because Task 3's `data-streaming`
  // guard disables the "Ask about this" menu row on the turn still in flight,
  // so every message
  // that CAN become a reference is already complete text; nothing under the
  // clone can still be mutated by the transcript watcher. The one thing that
  // *can* still change after cloning is theme/appearance (font, syntax
  // theme, `--fg` etc.) — those are CSS custom properties read at paint time,
  // not baked into the cloned markup, so a theme switch while a reference is
  // held re-styles the clone identically to the original.
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder || !reference?.anchor) return;
    const src = reference.anchor.host;
    if (!src) return;
    const copy = src.cloneNode(true) as HTMLElement;
    // (nothing to strip — the anchor never wrote attributes onto the source)
    holder.replaceChildren(copy);
    return () => holder.replaceChildren();
  }, [reference]);

  // FLIP: place the clone exactly over the real element (First), then
  // transform it to the viewport centre (Last) — chat references only.
  // Scroll-to-centre is NOT an option: the most likely right-click target is
  // the newest message, which sits directly above the composer with no
  // scroll room beneath it and can never reach centre by scrolling (spec
  // 2.1).
  //
  // Bug fix (task-8 review): this used to be ONE effect, deps
  // `[reference, travels, d]`, shared with the artifact clip-path logic
  // below. `d` is recomputed by useReferenceGeometry on EVERY scroll/resize
  // (it's the traced-outline path), but a travelling clone never reads `d`
  // at all — only the artifact branch does, for its clip-path. Sharing one
  // effect meant scrolling at any point during the 460ms travel re-ran the
  // whole thing: reset `transform` back to the source position and
  // re-scheduled the RAF that glides it to centre, visibly restarting the
  // travel. Splitting into two effects — this one keyed on
  // `[reference, travels]` only — means a travelling reference's FLIP runs
  // exactly once per reference and is inert to scroll/resize.
  useEffect(() => {
    const node = liftRef.current;
    if (!node || !reference?.anchor || !travels) return;
    const src = reference.anchor.host;
    if (!src) return;

    const s = src.getBoundingClientRect();
    node.style.left = `${s.left}px`;
    node.style.top = `${s.top}px`;
    node.style.width = `${s.width}px`;
    node.style.transform = 'translate(0, 0)';
    // Clear any clip-path a PREVIOUS artifact reference left on this node.
    // The node is reused (not remounted) when `reference` changes kind
    // without passing through null in between — e.g. the session-switch
    // park/restore in reference-context.tsx swapping straight from one
    // held reference to another.
    node.style.clipPath = 'none';

    // Next frame so the browser paints the First position before transitioning.
    const raf = requestAnimationFrame(() => {
      const h = node.offsetHeight;
      const dx = (window.innerWidth - s.width) / 2 - s.left;
      const dy = (window.innerHeight - h) / 2 - s.top;
      node.style.transform = `translate(${dx}px, ${dy}px)`;
    });
    return () => cancelAnimationFrame(raf);
  }, [reference, travels]);

  // Artifact clip: pin the clone over the source and clip it to the
  // selection (spec 2.2), so only the selected lines read at full --fg while
  // the rest of the window dims. Clipping the clone beats re-drawing the
  // text: multi-line selections (the headline case — "lines 12-18 of
  // engine.ts") keep exact glyphs, fonts, and highlighting.
  //
  // Deliberately a SEPARATE effect from the travel FLIP above, and
  // deliberately keeps `d` in its deps: unlike the travel case, there is no
  // animation here to interrupt, and the selection genuinely moves with the
  // page as the artifact pane scrolls — a stale clip-path would keep
  // clipping to where the selection USED to be, revealing the wrong lines.
  // Re-running this effect on every scroll/resize tick is exactly the
  // desired behaviour (this mirrors what the pre-split effect already did
  // for the non-travelling branch; only the travelling branch's re-run-on-
  // scroll was the bug).
  useEffect(() => {
    const node = liftRef.current;
    if (!node || !reference?.anchor || travels) return;
    const src = reference.anchor.host;
    if (!src) return;

    const s = src.getBoundingClientRect();
    node.style.left = `${s.left}px`;
    node.style.top = `${s.top}px`;
    node.style.width = `${s.width}px`;
    node.style.transform = 'translate(0, 0)';

    // `d` is built in VIEWPORT coordinates (use-reference-geometry.ts's
    // `origin = {left:0,top:0}`), which lines up for free with the trace
    // SVG (`.reference-trace` is `position:fixed; inset:0`, so ITS border
    // box origin IS the viewport origin). It does NOT line up for free
    // here: `clip-path: path()` resolves its coordinates against the
    // clipped element's OWN border box — this node's box starts at
    // (s.left, s.top), not (0,0), because it's pinned over the source.
    // Verified against the CSS Shapes spec (path() uses the same
    // reference-box rule polygon()/circle() use for percentages), not
    // assumed. Without shiftPath the clip silently lands offset by the
    // source's own position — correct only for a source pinned at the
    // viewport origin, which is not the general case.
    node.style.clipPath = d ? `path('${shiftPath(d, -s.left, -s.top)}')` : 'none';
  }, [reference, travels, d]);

  // Esc cancels. LIFO, so if a drawer opened on top, Esc closes that first.
  useEscClose(!!reference, clearReference);

  useEffect(() => {
    if (!reference) { depthAtOpen.current = null; return; }
    // Fix: capture the baseline AFTER this component's own useEscClose push has
    // registered, not before. useEscStackDepth() is read at render time, one
    // tick ahead of the push effect (which runs later in the same passive-effect
    // flush, in hook-declaration order) — so the FIRST render where reference is
    // truthy sees `depth` from before self-registration. Comparing later renders
    // (which correctly include the self-push) against that pre-push baseline
    // made this effect fire on its own registration and immediately clear the
    // reference it had just opened. +1 accounts for the self-push this
    // component's own useEscClose(!!reference, ...) call is about to add.
    if (depthAtOpen.current === null) { depthAtOpen.current = depth + 1; return; }
    // Something opened ON TOP of us. We live in the L2 band, so an L1 drawer
    // (z-40/50) would render UNDER this scrim. Cancel instead of painting over
    // it — the two states are mutually exclusive by design (spec §6).
    //
    // Known, ACCEPTED edge case (review Finding 3): this is a COUNT comparison,
    // not an identity check on "what's above us in the stack." If some OTHER
    // useEscClose-registering overlay opens in the exact SAME React commit as
    // this one's own registration (e.g. one event handler synchronously flips
    // both an overlay's `open` state and calls setReference — React 18 batches
    // that into one commit), both pushes land in the same passive-effect flush,
    // and the depth baseline captured just above can't tell whether the other
    // push landed above or below ours in the LIFO stack — it only sees total
    // depth grow by 2 instead of the expected 1, so this fires and cancels the
    // reference even in the (rare) ordering where ours ended up on top.
    // Deliberately NOT distinguishing that ordering: the L2 band is already
    // documented as mutually-exclusive-with-anything-else by design (spec §6),
    // and "silently drop a reference that could have safely coexisted with
    // itself on top" is a strictly safer failure mode than the alternative
    // (an identity-based rewrite of the shared, app-wide useEscClose stack —
    // touching that has a much larger blast radius than one feature's edge
    // case). So: any contention for the L2 band — sequential OR same-commit —
    // makes the reference yield. Pinned by
    // ReferenceOverlay.test.tsx's "same-commit L2 contention" test.
    if (depth > depthAtOpen.current) clearReference();
  }, [reference, depth, clearReference]);

  // Mark the document so the composer can lift above the scrim (globals.css'
  // `body[data-reference-held] .bottom-float` rule — review Finding 1/2 fix).
  // The layer NUMBER is not hardcoded in CSS: Overlay.tsx is the one place a
  // layer number is decided (design rule 11), so publish REFERENCE_COMPOSER_Z
  // as a CSS custom property here and let the stylesheet consume var(...).
  // Both the attribute and the var are cleaned up on unmount/clear so nothing
  // about normal (no-reference-held) chrome ordering is ever affected.
  useEffect(() => {
    if (!reference) return;
    document.body.setAttribute('data-reference-held', 'true');
    document.body.style.setProperty('--reference-composer-z', String(REFERENCE_COMPOSER_Z));
    return () => {
      document.body.removeAttribute('data-reference-held');
      document.body.style.removeProperty('--reference-composer-z');
    };
  }, [reference]);

  if (!reference) return null;

  return createPortal(
    <Scrim layer={2} onClick={clearReference} className="reference-scrim">
      {/* Traced outline around the referenced selection/element (Task 7).
          pathLength={100} normalizes both paths' length to 100 units so the
          fixed 100-unit stroke-dasharray/breathe animation in globals.css
          works regardless of the actual traced perimeter. Empty when the
          source is gone (host disconnected) — nothing renders in that case. */}
      {d && (
        <svg className="reference-trace" aria-hidden="true" data-reduced={reducedEffects ? 'true' : undefined}>
          <path className="wash" d={d} />
          <path className="outline" d={d} pathLength={100} />
        </svg>
      )}
      {/* Task 8: the clone. Chat kinds travel to centre (`data-travels`
          drives the CSS transition + the non-clipping shadow/scroll rules);
          artifact kinds stay pinned over the source and get clipped instead
          (see the positioning effect above). data-reduced (Task 9) disables
          the travel transition and drops the lift shadow back to standard. */}
      <div
        ref={liftRef}
        className="reference-lift"
        data-travels={travels ? 'true' : undefined}
        data-reduced={reducedEffects ? 'true' : undefined}
      >
        <div ref={holderRef} className="reference-lift-card" />
        {/* Cancel affordance pinned to the lifted card itself, not the
            viewport corner, once there IS a card to pin it to. */}
        {travels && (
          // pointer-events-auto (review finding): `.reference-lift` itself is
          // pointer-events: none (globals.css) so mouse events fall through to
          // the scrim beneath everywhere except the explicitly-restored
          // `.reference-lift-card`. This wrapper is a SIBLING of that card, not
          // a descendant, so it doesn't inherit the restore — without this
          // class the button is un-hoverable and un-clickable; the click that
          // "worked" was really landing on the scrim's own onClick behind it.
          // Same idiom as Toast.tsx's action slot.
          <div className="absolute -top-3 -right-3 pointer-events-auto">
            <CloseButton label="Cancel reference" onClick={clearReference} />
          </div>
        )}
      </div>
      {/* Artifact case has no travelling card, so the cancel affordance stays
          parked in the viewport corner — always escapable by mouse. */}
      {!travels && (
        // pointer-events-auto: not strictly load-bearing today (this wrapper
        // sits directly under `.reference-scrim`, which has no pointer-events
        // rule of its own, so it's already hit-testable) — but declared
        // explicitly anyway so the invariant doesn't depend on staying
        // outside `.reference-lift`'s pointer-events: none subtree. Matches
        // the travelling-case wrapper above rather than relying on a CSS
        // ancestry detail a future refactor could silently change.
        <div className="absolute top-4 right-4 pointer-events-auto">
          <CloseButton label="Cancel reference" onClick={clearReference} />
        </div>
      )}
    </Scrim>,
    document.body,
  );
}
