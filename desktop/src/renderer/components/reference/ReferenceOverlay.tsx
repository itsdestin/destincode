import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Scrim, REFERENCE_COMPOSER_Z } from '../overlays/Overlay';
import { CloseButton } from '../ui/CloseButton';
import { useReference } from '../../state/reference-context';
import { useEscClose, useEscStackDepth } from '../../hooks/use-esc-close';
import { useReferenceGeometry } from './use-reference-geometry';

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
  const depth = useEscStackDepth();
  const depthAtOpen = useRef<number | null>(null);
  // Task 7: the traced outline around the referenced content. `rects` is
  // unused here — Task 8 needs it to redraw the selected runs above the scrim.
  const { d } = useReferenceGeometry(reference?.anchor ?? null);

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
        <svg className="reference-trace" aria-hidden="true">
          <path className="wash" d={d} />
          <path className="outline" d={d} pathLength={100} />
        </svg>
      )}
      {/* Cancel affordance. Positioned by Task 8 against the lifted card; until
          then it parks top-right so the state is always escapable by mouse. */}
      <div className="absolute top-4 right-4">
        <CloseButton label="Cancel reference" onClick={clearReference} />
      </div>
    </Scrim>,
    document.body,
  );
}
