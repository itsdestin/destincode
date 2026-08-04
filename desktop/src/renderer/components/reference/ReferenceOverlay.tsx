import React, { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Scrim, REFERENCE_COMPOSER_Z } from '../overlays/Overlay';
import { CloseButton } from '../ui/CloseButton';
import { useReference } from '../../state/reference-context';
import { useTheme } from '../../state/theme-context';
import { useEscClose, useEscStackDepth } from '../../hooks/use-esc-close';
import { useReferenceGeometry } from './use-reference-geometry';
import { shiftPath } from './reference-geometry';
import { applyHighlightMark } from './apply-highlight';

// Mirrors the duration in globals.css's `.reference-lift { transition:
// transform 460ms ... }` — not read from the stylesheet (no clean way to
// introspect a computed transition-duration before the transition itself has
// started), just kept numerically in sync by hand. If that rule's duration
// ever changes, this constant must change with it. Module-level: it's a
// static value, not per-render state.
const RETURN_DURATION_MS = 460;

/**
 * The held "Ask Claude about this" reference (spec 2026-07-26).
 *
 * One app-wide instance. Owns the window-wide dim, the lifted clone (Task 8),
 * and the traced outline around the highlighted selection (Task 7, restored
 * 2026-07-28 — see the WHY comment on `useReferenceGeometry` below for what
 * changed the second time around).
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

    // Dev-review fix B: show WHICH PART was selected, inside the clone.
    // `selection` is a pair of character offsets computed against the LIVE
    // host (build-reference.ts's computeSelectionOffsets) — they map onto
    // `copy` unchanged because cloneNode(true) preserves host's exact
    // text-node order and lengths. Applied to the CLONE, never the source:
    // mutating a detached clone is safe (see apply-highlight.ts's WHY
    // comment); mutating the live source is exactly the class of change that
    // crashed React's reconciler under the withdrawn surroundContents()
    // design. Best-effort — if the offsets don't resolve (e.g. a stale
    // selection that no longer maps onto the current DOM shape),
    // applyHighlightMark silently no-ops rather than throwing, so a bad
    // offset degrades to "no highlight" instead of a broken reference.
    const sel = reference.anchor.selection;
    if (sel) {
      try {
        applyHighlightMark(copy, sel.start, sel.end);
      } catch {
        // Skip the highlight rather than losing the whole clone over it.
      }
    }

    holder.replaceChildren(copy);
    return () => holder.replaceChildren();
  }, [reference]);

  // Restored 2026-07-28 (see the file-header WHY comment): `d` traces the
  // `.reference-mark` elements INSIDE THE CLONE (liftRef's subtree), not the
  // original source — the fix for the travelling-card case pointing at empty
  // space, by construction. One measurement feeds BOTH the SVG outline drawn
  // in the JSX below AND (for the artifact, non-travelling case only) the
  // clip-path effect further down, so they can never show two different
  // shapes. Declared here — after the clone-population effect above, before
  // the positioning effects below — purely so `d`/`remeasure` are in lexical
  // scope for the clip effect's dependency array and body; the hook's OWN
  // internal effects are independently correct regardless of call-site order
  // (see its WHY comments), and the positioning effects below call
  // `remeasure()` explicitly right after they set left/top/transform so the
  // very first paint is accurate rather than racing this hook's own
  // mount-time measurement against those styles being set.
  const { d, remeasure } = useReferenceGeometry(liftRef, !!reference, reference);

  // Dev-review fix 1: "I don't like that I can see both the original message
  // and the centered message. It should be the same bubble that appears to
  // move." Hide the SOURCE bubble for the duration a CHAT (travelling)
  // reference is held, so the clone reads as the original having moved
  // rather than a second copy appearing alongside it. Scoped to `travels`
  // only — the artifact (pinned/clipped) case deliberately still shows the
  // dimmed original underneath its clipped-bright clone; hiding it there
  // would blank out everything outside the selection instead of dimming it.
  //
  // visibility: hidden, NOT display: none — the transcript's layout box must
  // stay in place. display: none would collapse the row's height and reflow
  // every message below it while the dim is up, which is its own visible
  // glitch (and would also break the FLIP "First" measurement, which reads
  // the source's live rect).
  //
  // Inline style only, restored to its EXACT prior value (not hardcoded back
  // to ''): some other feature could already have an inline `visibility` on
  // this element for an unrelated reason, and clobbering that on clear would
  // leave it wrong. This is NOT the same class of change as the withdrawn
  // Range.surroundContents() design (see reference-context.tsx's WHY
  // comment) — that SPLIT TEXT NODES, a structural DOM mutation React's
  // fiber tree loses track of. Toggling one existing inline style property
  // adds/removes no nodes, classes, or attributes, and React never wrote
  // this property itself, so there is nothing for the next reconcile to
  // disagree with.
  useEffect(() => {
    if (!reference?.anchor || !travels) return;
    const src = reference.anchor.host as HTMLElement;
    if (!src || !src.style) return;
    const prevVisibility = src.style.visibility;
    // Remember whether `style` existed at all BEFORE we touch it: setting a
    // longhand property back to '' correctly drops it from cssText (verified
    // against jsdom — `style.length` falls back to 0 when it was the only
    // property), but browsers never auto-remove the now-empty `style=""`
    // ATTRIBUTE itself, only an explicit removeAttribute does. Restoring
    // "exactly" means the source ends up with NO style attribute at all if it
    // never had one — not a harmless-looking but still-different `style=""`
    // husk left behind in the live transcript's markup.
    const hadStyleAttr = src.hasAttribute('style');
    src.style.visibility = 'hidden';
    return () => {
      src.style.visibility = prevVisibility;
      if (!hadStyleAttr && src.style.length === 0) src.removeAttribute('style');
    };
  }, [reference, travels]);

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

    // Issue A (final review): detached source. Reachable when a session
    // switch away-and-back restores a PARKED reference (reference-context.tsx)
    // whose original message DOM was replaced meanwhile by ChatView — the
    // reference object survives, but `src` is no longer in the document.
    // getBoundingClientRect() on a disconnected element returns an all-zero
    // rect, which used to compute a bogus FLIP "First" position and land the
    // card pinned in the viewport's top-left corner. Spec §7 wants a
    // non-anchored, CENTRED card instead. The clone itself is still valid —
    // captured once at reference-creation time in the effect above,
    // independent of what happens to `src` afterward — so there is still
    // content to show; only these positioning inputs are gone.
    //
    // Deliberately NO FLIP/RAF animation here: a "travel" implies a real
    // start position to fly from, and a zero rect isn't one — animating from
    // it would just be a meaningless slide from the corner, not a motion that
    // means anything. The card simply appears centred. `data-detached` lets
    // globals.css force `transition: none` too, so this doesn't depend on
    // timing to avoid a stray CSS-transition slide from whatever inline
    // transform this reused node happened to carry from its last attached
    // measurement.
    if (!src.isConnected) {
      node.setAttribute('data-detached', 'true');
      node.style.left = '50%';
      node.style.top = '50%';
      node.style.width = 'min(90vw, 640px)';
      node.style.transform = 'translate(-50%, -50%)';
      node.style.clipPath = 'none';
      remeasure(); // outline still needs to trace the (centred) marks even without a live FLIP
      return;
    }
    node.removeAttribute('data-detached');

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
    // Fix: this hook's own mount-time measurement (useReferenceGeometry's
    // internal effect) can run BEFORE this positioning effect in the same
    // commit (hook-call order isn't guaranteed the other way), which would
    // read the marks at whatever position the REUSED node last had — an
    // explicit remeasure() here, right after left/top/transform are set,
    // guarantees the "First" position's outline is correct regardless of
    // that ordering.
    remeasure();

    // Next frame so the browser paints the First position before transitioning.
    const raf = requestAnimationFrame(() => {
      const h = node.offsetHeight;
      const dx = (window.innerWidth - s.width) / 2 - s.left;
      const dy = (window.innerHeight - h) / 2 - s.top;
      node.style.transform = `translate(${dx}px, ${dy}px)`;
      // The "Last" (centred) position. `transitionrun` (see
      // useReferenceGeometry) picks up the continuous mid-flight tracking
      // from here — this call just guarantees the FINAL settle is correct
      // even in an environment where the transition doesn't fire (reduced
      // motion, transition: none).
      remeasure();
    });
    return () => cancelAnimationFrame(raf);
    // remeasure is NOT listed as a dep: it's useReferenceGeometry's `measure`
    // callback, memoized on `[containerRef, active]` — containerRef (liftRef)
    // never changes identity and `active` (`!!reference`) only flips exactly
    // when `reference` does, which is already this effect's own dependency.
    // Listing it would add nothing; NOT listing it is what keeps this effect
    // inert to the geometry hook's own re-renders, same reasoning as `d`
    // being excluded below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  //
  // Restoration note: `d` now comes from the marks INSIDE THIS CLONE, not
  // the source anymore (see useReferenceGeometry's WHY comment) — but since
  // the artifact clone is pinned exactly over the source, the marks land at
  // the same screen position the source's own range used to measure, so the
  // clip behaves identically for the common case. The one deliberate change:
  // a reference with NO partial selection (no marks) now clips to nothing
  // (`d` is `''`, so `clip-path: none`) instead of the old fallback of
  // clipping to the whole host box — a no-op clip in practice (the pinned
  // clone's own box already IS that rect), so `none` is simpler for the
  // exact same visible result.
  useEffect(() => {
    const node = liftRef.current;
    if (!node || !reference?.anchor || travels) return;
    const src = reference.anchor.host;
    if (!src) return;

    // Issue B (final review): same detached-source handling as the travel
    // effect above, for the artifact (non-travelling) branch — reachable
    // when the file tab holding the referenced selection is switched or
    // closed while the reference stays held. No clip either: a stale
    // selection rect no longer corresponds to anything on screen, so
    // clipping to it would just hide the (still-valid) clone behind an
    // arbitrary mask. See the WHY comment on the travel effect for the full
    // reasoning (no FLIP animation, `data-detached` drives the CSS side).
    if (!src.isConnected) {
      node.setAttribute('data-detached', 'true');
      node.style.left = '50%';
      node.style.top = '50%';
      node.style.width = 'min(90vw, 640px)';
      node.style.transform = 'translate(-50%, -50%)';
      node.style.clipPath = 'none';
      remeasure();
      return;
    }
    node.removeAttribute('data-detached');

    const s = src.getBoundingClientRect();
    node.style.left = `${s.left}px`;
    node.style.top = `${s.top}px`;
    node.style.width = `${s.width}px`;
    node.style.transform = 'translate(0, 0)';

    // `d` is built in VIEWPORT coordinates (use-reference-geometry.ts's
    // `origin = {left:0,top:0}`). `clip-path: path()` does NOT resolve its
    // coordinates against the viewport — it resolves against the clipped
    // element's OWN border box, and this node's box starts at (s.left,
    // s.top), not (0,0), because it's pinned over the source. Verified
    // against the CSS Shapes spec (path() uses the same reference-box rule
    // polygon()/circle() use for percentages), not assumed. Without
    // shiftPath the clip silently lands offset by the source's own
    // position — correct only for a source pinned at the viewport origin,
    // which is not the general case.
    node.style.clipPath = d ? `path('${shiftPath(d, -s.left, -s.top)}')` : 'none';
    // `d` may still be stale here (measured against wherever this REUSED
    // node was positioned last, if useReferenceGeometry's own mount effect
    // ran before this one in the same commit) — remeasure() now that
    // left/top are correct triggers a fresh `d`, which re-runs THIS effect
    // (it's in the deps below) with the accurate clip on the very next pass.
    remeasure();
  }, [reference, travels, d]);

  // Dev-review follow-up: "there is an animation to center them, but I want
  // an animation to move it back into place when I click out / exit the ask
  // mode." Esc, the scrim click, and the × button all route through THIS
  // function now instead of calling `clearReference()` straight from context
  // — see the WHY block below for why that indirection is the whole trick.
  //
  // Sending a message must NOT play this animation (the reference is
  // consumed, not cancelled — spec says it "clears immediately"). InputBar's
  // send() still calls the context's `clearReference()` DIRECTLY (see
  // reference-context.tsx), never this function, so the distinction is
  // structural: whichever code path calls beginExit() is by definition a
  // user cancel, and whichever calls context.clearReference() directly is
  // by definition an immediate consume/discard. No flag, no "was this a
  // send" boolean to keep in sync — the CALL SITE is the signal.
  //
  // Mechanism: this does NOT null the context's `reference` up front. It
  // only re-targets the clone's `transform` (the existing CSS transition on
  // `.reference-lift` — see globals.css — animates between whatever value
  // was last painted and this new one, no JS interpolation needed) and
  // defers the REAL `clearReference()` call until after the transition
  // would have finished. Because `reference` stays truthy for the whole
  // return trip, every other effect in this component that keys off it —
  // the source-visibility hide, the body `data-reference-held` attribute —
  // keeps doing exactly what it already does for a held reference, with no
  // extra plumbing: the source only pops back into view (and the body
  // attribute only clears) at the SAME moment `reference` finally goes
  // null, which is the end of the flight, not the start. That's what
  // prevents the "two copies visible" bug this feature already fixed once
  // (see the source-hide effect's WHY comment above) from coming back on
  // the way OUT.
  const exitingRef = useRef(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const beginExit = useCallback(() => {
    if (!reference) return; // nothing held — nothing to cancel
    if (exitingRef.current) return; // already animating out; a second Esc/click mid-flight is a no-op, not a restart

    const node = liftRef.current;
    const src = reference.anchor?.host as HTMLElement | undefined;
    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

    // Clear immediately, no animation, when there is nothing meaningful to
    // animate:
    //   - !travels (artifact): the clone never travelled anywhere, so there
    //     is no return trip to make — same reasoning as the entry effect,
    //     which never runs the FLIP choreography for this kind either.
    //   - reducedEffects / prefers-reduced-motion: motion is opted out.
    //   - no anchor, no node, or a detached source: no live rect to fly
    //     BACK TO. Animating to a stale/zero rect would be exactly the
    //     "meaningless slide from the corner" the entry effect's own
    //     detached-source branch already refuses to do (see its WHY
    //     comment) — same call, applied to the exit direction.
    if (!travels || reducedEffects || prefersReducedMotion || !node || !src || !src.isConnected) {
      clearReference();
      return;
    }

    exitingRef.current = true;
    // Diagnostic/test hook, not load-bearing for any CSS rule today — lets a
    // test (or a future style) distinguish "flying in" from "flying out"
    // without re-deriving it from transform math.
    node.setAttribute('data-exiting', 'true');

    // Reverse FLIP. `node.style.left`/`top` are still the ENTRY "First"
    // position (the source's rect at the moment the reference was taken —
    // nothing has touched them since), so express the CURRENT source rect
    // as a delta from that SAME anchor and hand it to `transform`. No RAF
    // needed here, unlike the entry effect: the node is already painted at
    // its centred position (it's been sitting there since entry), so simply
    // assigning a NEW `transform` value lets the existing CSS transition
    // animate FROM that already-painted value TO this one. The entry effect
    // needs the RAF trick only because it sets left/top and
    // transform:translate(0,0) in the same synchronous pass, before
    // anything has painted — a same-tick change has no visible "before"
    // state to transition from.
    const originalLeft = parseFloat(node.style.left) || 0;
    const originalTop = parseFloat(node.style.top) || 0;
    const s = src.getBoundingClientRect();
    // Snap width to the source's CURRENT size (not transitioned, same as the
    // entry effect's one-time width set) — the brief asks for "the source
    // element's current rect", and the source's width may have reflowed
    // (e.g. a window resize) while the reference was held.
    node.style.width = `${s.width}px`;
    node.style.transform = `translate(${s.left - originalLeft}px, ${s.top - originalTop}px)`;

    exitTimerRef.current = setTimeout(() => {
      exitingRef.current = false;
      exitTimerRef.current = null;
      // The REAL clear. Only now — after the flight has had time to finish —
      // does `reference` actually go null, which is what lets the source and
      // the body attribute pop back at the right moment (see the block
      // comment above).
      clearReference();
    }, RETURN_DURATION_MS);
  }, [reference, travels, reducedEffects, clearReference]);

  // Safety net for two cases at once: (1) the component unmounts mid-flight
  // (a pending timer must not fire clearReference() against a dead
  // component's stale closure), and (2) `reference` changes out from under
  // an in-flight exit for some OTHER reason (e.g. a brand new reference gets
  // set before the old one's return trip finished) — the stale timer must
  // not later clear the NEW reference. Keyed on `reference` alone: this
  // cleanup runs on every identity change of `reference`, including the
  // exit timer's own eventual `clearReference()` call, at which point
  // `exitTimerRef.current` is already null and this is a harmless no-op.
  useEffect(() => {
    return () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      exitingRef.current = false;
    };
  }, [reference]);

  // Esc cancels — via beginExit, not a direct clearReference, so Esc plays
  // the return animation like the scrim click and × button do. LIFO, so if a
  // drawer opened on top, Esc closes that first (unrelated to this feature).
  useEscClose(!!reference, beginExit);

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
    //
    // Deliberately calls clearReference() DIRECTLY, not beginExit(): this
    // fires because something else just claimed the L2 band and is about to
    // paint over this scrim, not because the user asked to cancel. Whatever
    // opened on top would visually cover a return flight anyway, and
    // yielding immediately keeps this already-accepted-as-lossy edge case
    // (see the Finding 3 comment above) simple rather than layering an
    // animation underneath a state where "cancel" wasn't really the intent.
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
    <Scrim layer={2} onClick={beginExit} className="reference-scrim">
      {/* Traced outline around the highlighted selection (Task 7, restored
          2026-07-28). pathLength={100} normalizes both paths' length to 100
          units so the fixed 100-unit stroke-dasharray/breathe animation in
          globals.css works regardless of the actual traced perimeter. Renders
          for BOTH kinds now — unlike the original (and the since-deleted)
          version, which only ever traced the non-travelling/artifact case,
          this one is anchored to the `.reference-mark` elements INSIDE THE
          CLONE (see useReferenceGeometry's WHY comment), so for a travelling
          chat reference it tracks the marks wherever the clone currently is
          — never the empty space the source left behind, which was the
          original bug. Empty (nothing renders) when there's no partial
          selection to trace — a whole-message/whole-file reference already
          has its own "this is the reference" signal (the travelling card's
          ring, or simply being the one undimmed clone), so an outline around
          the entire clone would just duplicate that, not clarify it. */}
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
            <CloseButton
              label="Cancel reference"
              onClick={beginExit}
              // Solid circular chip: the default ghost variant is transparent,
              // which vanishes against a wallpaper theme (Destin, dev review).
              // bg-panel + border-edge keeps it theme-driven, never a literal.
              className="rounded-full bg-panel border border-edge text-fg-2 hover:bg-inset hover:text-fg shadow-sm"
            />
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
          <CloseButton
              label="Cancel reference"
              onClick={beginExit}
              // Solid circular chip: the default ghost variant is transparent,
              // which vanishes against a wallpaper theme (Destin, dev review).
              // bg-panel + border-edge keeps it theme-driven, never a literal.
              className="rounded-full bg-panel border border-edge text-fg-2 hover:bg-inset hover:text-fg shadow-sm"
            />
        </div>
      )}
    </Scrim>,
    document.body,
  );
}
