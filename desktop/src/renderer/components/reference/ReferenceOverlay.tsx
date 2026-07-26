import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Scrim } from '../overlays/Overlay';
import { CloseButton } from '../ui/CloseButton';
import { useReference } from '../../state/reference-context';
import { useEscClose, useEscStackDepth } from '../../hooks/use-esc-close';

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
    if (depth > depthAtOpen.current) clearReference();
  }, [reference, depth, clearReference]);

  // Mark the document so the composer can lift above the scrim (globals.css).
  useEffect(() => {
    if (!reference) return;
    document.body.setAttribute('data-reference-held', 'true');
    return () => document.body.removeAttribute('data-reference-held');
  }, [reference]);

  if (!reference) return null;

  return createPortal(
    <Scrim layer={2} onClick={clearReference} className="reference-scrim">
      {/* Cancel affordance. Positioned by Task 8 against the lifted card; until
          then it parks top-right so the state is always escapable by mouse. */}
      <div className="absolute top-4 right-4">
        <CloseButton label="Cancel reference" onClick={clearReference} />
      </div>
    </Scrim>,
    document.body,
  );
}
