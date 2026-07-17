import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from '../../state/theme-context';
import { useThemeMascot } from '../../hooks/useThemeMascot';
import { useAnyAttentionNeeded } from '../../hooks/useAnyAttentionNeeded';
import { MascotRig, type RigMotion } from '../mascot/MascotRig';
import type { PoseName } from '../mascot/mascot-poses';

const DRAG_THRESHOLD_PX = 4;
// Drag velocity is normalized to the 80px buddy-window scale before feeding
// the limb springs (spec §5: k = 80/size × 2.4) so trailing feels identical
// at any render size (the buddy renders at 112px since the 2026-07-16 bump).
const DRAG_VELOCITY_GAIN = (80 / 112) * 2.4;
// Hover-hop dwell. The sink transition is 380ms each way, so this leaves him
// fully out for a beat before he sinks back — long enough to read as a peek-a-boo
// rather than a glitch, short enough to still read as "immediately" (Destin).
const HOP_MS = 700;

// Pointer-driven drag state. Anchor-based: we capture the cursor's offset
// inside the 80×80 mascot at pointerdown (grabOffsetX/Y from e.clientX/Y)
// and recompute the absolute target on every pointermove as
// (e.screenX - grabOffsetX, e.screenY - grabOffsetY). This keeps the cursor
// locked to the same pixel inside the mascot for the full drag, regardless
// of HiDPI rounding, threshold deadzones, or edge-clamp rubber-banding.
// A prior delta-based design caused visible drift on fractional-scale
// (125 / 150%) Windows displays because each round-tripped dx/dy rounded
// independently and the residual compounded. lastScreenX/Y + totalTravel
// are only used to distinguish a genuine drag from a jittery click.
interface DragState {
  grabOffsetX: number;
  grabOffsetY: number;
  lastScreenX: number;
  lastScreenY: number;
  lastMoveTime: number;
  totalTravel: number;
  pointerId: number;
}

export interface MascotDockState { mode: 'free' | 'docked' | 'peeking'; edge: string | null; }

export function BuddyMascot() {
  const attention = useAnyAttentionNeeded();
  const { activeTheme, reducedEffects } = useTheme();

  // Mascot resolution order (spec §3.5): theme rig → theme flat art →
  // first-party default rig. Flat art is the legacy tier: it gets the
  // wrapper-level effects below but no limb trailing / blink / peek hands.
  const rigUrl = activeTheme?.mascot?.rig ?? null;
  const variantMascot = useThemeMascot(attention ? 'shocked' : 'idle');
  const welcomeMascot = useThemeMascot('welcome');
  const flatMascot = variantMascot ?? welcomeMascot;
  const useRig = !!rigUrl || !flatMascot;

  // Dock/peek state pushed from main (buddy:mascot-state). The sink/lean
  // transforms are data-attr driven via buddy.css so they CSS-transition.
  const [dock, setDock] = useState<MascotDockState>({ mode: 'free', edge: null });
  // Swing-out whip (spec §6.2): leaving a SIDE peek releases the −/+75° lean
  // through a short overshoot past vertical before settling at 0.
  const [swing, setSwing] = useState<'left' | 'right' | null>(null);
  const swingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const triggerSwing = useCallback((edge: 'left' | 'right') => {
    setSwing(edge);
    // Whip past vertical for ~230ms, then let the rotate transition settle to 0.
    if (swingTimerRef.current) clearTimeout(swingTimerRef.current);
    swingTimerRef.current = setTimeout(() => setSwing(null), 230);
  }, []);
  const prevDockRef = useRef<MascotDockState>({ mode: 'free', edge: null });
  useEffect(() => {
    const off = window.claude?.buddy?.onMascotState?.((s: MascotDockState) => {
      const prev = prevDockRef.current;
      prevDockRef.current = s;
      if (
        prev.mode === 'peeking' && (prev.edge === 'left' || prev.edge === 'right') &&
        s.mode !== 'peeking'
      ) {
        triggerSwing(prev.edge as 'left' | 'right');
      }
      setDock(s);
    });
    return off;
  }, [triggerSwing]);

  // Hover hop (Destin 2026-07-17): hovering a peeking buddy pops him out for a
  // beat and then he sinks straight back — an acknowledgement, not a mode
  // change, which is why it lives here and not in the dock reducer. Only a
  // CLICK brings him out for real (it opens the chat, which engages the dock
  // main-side). Peek itself is now entered by dropping him on an edge; there is
  // no idle timer any more.
  const [hopping, setHopping] = useState(false);
  const hopTimerRef = useRef<NodeJS.Timeout | null>(null);
  const onPointerEnter = useCallback(() => {
    if (dock.mode !== 'peeking') return;
    if (dock.edge === 'left' || dock.edge === 'right') triggerSwing(dock.edge);
    setHopping(true);
    if (hopTimerRef.current) clearTimeout(hopTimerRef.current);
    hopTimerRef.current = setTimeout(() => setHopping(false), HOP_MS);
  }, [dock.mode, dock.edge, triggerSwing]);
  // Any dock change ends a hop — he's somewhere else now.
  useEffect(() => { setHopping(false); }, [dock.mode, dock.edge]);
  useEffect(() => () => {
    if (hopTimerRef.current) clearTimeout(hopTimerRef.current);
    if (swingTimerRef.current) clearTimeout(swingTimerRef.current);
  }, []);

  // Attention bounce: retrigger the CSS animation each time attention flips on.
  const [bounceKey, setBounceKey] = useState(0);
  useEffect(() => { if (attention) setBounceKey((k) => k + 1); }, [attention]);

  const [grabbed, setGrabbed] = useState(false);

  // A hop temporarily renders him as if he were docked: sink released, peek
  // pose dropped, grip mittens gone. Everything downstream reads `peeking`
  // rather than dock.mode so the three can't disagree mid-hop.
  const peeking = dock.mode === 'peeking' && !hopping;
  const sidePeek = peeking && (dock.edge === 'left' || dock.edge === 'right');
  // Resting = 'idle' (open-eyed welcome face); the rig-authored chevron-eye
  // face lives in 'pressed', shown only while held (Destin 2026-07-16).
  const pose: PoseName = attention
    ? 'shocked'
    : peeking
      ? (dock.edge === 'left' ? 'peek-left' : dock.edge === 'right' ? 'peek-right' : 'peek')
      : grabbed
        ? 'pressed'
        : 'idle';
  const dragRef = useRef<DragState | null>(null);
  // Smoothed drag velocity for the rig's limb springs. A ref — pointermove-rate
  // React state would re-render 60×/s for nothing.
  const motionRef = useRef<RigMotion>({ vx: 0, vy: 0, dragging: false });
  const rigHostRef = useRef<HTMLDivElement>(null);

  // rAF-coalesce the moveMascot IPC. Without this, captured pointermoves on
  // high-refresh mice can fire faster than the display refresh — every extra
  // event per frame is one extra IPC main has to drain, and every frame it
  // processes an already-stale cursor position. "Squishy" lag under fast
  // drags. rAF throttling keeps at most one move in flight per frame, always
  // targeting the latest cursor position.
  const pendingTargetRef = useRef<{ targetX: number; targetY: number } | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const flushPendingMove = useCallback(() => {
    rafIdRef.current = null;
    const target = pendingTargetRef.current;
    if (!target) return;
    pendingTargetRef.current = null;
    window.claude?.buddy?.moveMascot?.(target);
  }, []);

  const cancelPendingMove = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    pendingTargetRef.current = null;
  }, []);

  // Drop any unflushed frame on unmount so a torn-down component can't keep
  // firing IPCs via a stranded rAF callback.
  useEffect(() => cancelPendingMove, [cancelPendingMove]);

  const endDrag = useCallback((notifyMain: boolean) => {
    const wasDragging = !!dragRef.current && dragRef.current.totalTravel > DRAG_THRESHOLD_PX;
    dragRef.current = null;
    motionRef.current = { vx: 0, vy: 0, dragging: false };
    setGrabbed(false);
    // Snap detection runs main-side against final window bounds (spec §6.1).
    if (notifyMain && wasDragging) window.claude?.buddy?.dragEnded?.();
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // setPointerCapture keeps pointermove/up flowing even if the pointer
    // leaves the 80×80 window during a fast drag.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    dragRef.current = {
      // clientX/Y is the cursor's offset inside the mascot content area.
      // Captured once and held constant — this is the anchor the rest of
      // the drag rewinds to.
      grabOffsetX: e.clientX,
      grabOffsetY: e.clientY,
      lastScreenX: e.screenX,
      lastScreenY: e.screenY,
      lastMoveTime: performance.now(),
      totalTravel: 0,
      pointerId: e.pointerId,
    };
    setGrabbed(true);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragRef.current;
    if (!st) return;
    const dx = e.screenX - st.lastScreenX;
    const dy = e.screenY - st.lastScreenY;
    if (dx === 0 && dy === 0) return;
    const now = performance.now();
    const dt = Math.max(1, now - st.lastMoveTime);
    st.lastScreenX = e.screenX;
    st.lastScreenY = e.screenY;
    st.lastMoveTime = now;
    st.totalTravel += Math.abs(dx) + Math.abs(dy);
    // Only start forwarding moves once we've crossed the click-vs-drag
    // threshold, so a jittery click doesn't nudge the window by a pixel.
    if (st.totalTravel > DRAG_THRESHOLD_PX) {
      // Exponentially smoothed velocity in px/frame (16ms), normalized for
      // the limb springs (spec §5); decay while held runs in the rig's loop.
      const m = motionRef.current;
      m.dragging = true;
      m.vx = 0.7 * m.vx + 0.3 * (dx / dt) * 16 * DRAG_VELOCITY_GAIN;
      m.vy = 0.7 * m.vy + 0.3 * (dy / dt) * 16 * DRAG_VELOCITY_GAIN;
      // Absolute target in screen coords: cursor position minus the offset
      // captured at pointerdown. Main clamps and rounds once. Schedule
      // (don't fire) — rAF coalesces multiple moves within a frame to the
      // latest target so we don't queue stale positions behind main.
      pendingTargetRef.current = {
        targetX: e.screenX - st.grabOffsetX,
        targetY: e.screenY - st.grabOffsetY,
      };
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(flushPendingMove);
      }
    }
  }, [flushPendingMove]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Flush any unsent move synchronously before release — otherwise the
    // mascot ends one frame behind the cursor's final resting position.
    const pending = pendingTargetRef.current;
    cancelPendingMove();
    if (pending) window.claude?.buddy?.moveMascot?.(pending);

    const st = dragRef.current;
    const wasClick = !!st && st.totalTravel <= DRAG_THRESHOLD_PX;
    if (st) { try { e.currentTarget.releasePointerCapture(st.pointerId); } catch { /* ignore */ } }
    endDrag(true);
    if (wasClick && window.claude?.buddy?.toggleChat) {
      window.claude.buddy.toggleChat();
    }
  }, [cancelPendingMove, endDrag]);

  // Safety net for "stuck being dragged": if the OS revokes pointer capture
  // (system modal, focus loss mid-drag) or a touch/pen device synthesizes
  // pointercancel instead of pointerup, pointerup never fires on this
  // window — without these handlers, dragRef stays set and subsequent
  // pointermoves over the mascot would keep dragging it after the button
  // was already released.
  const onLostPointerCapture = useCallback(() => { cancelPendingMove(); endDrag(true); }, [cancelPendingMove, endDrag]);
  const onPointerCancel = useCallback(() => { cancelPendingMove(); endDrag(true); }, [cancelPendingMove, endDrag]);

  return (
    <div
      className={[
        'mascot-wrap',
        grabbed ? 'mascot-grabbed' : '',
        // Flat art has no rig-root idle loop — it breathes at the wrapper.
        // Rigs breathe internally (MascotRig motion-style loop); double-
        // breathing would compound the translate.
        !useRig && !reducedEffects && !grabbed && !peeking ? 'mascot-breathing' : '',
      ].filter(Boolean).join(' ')}
      style={{
        // 112px window (main.ts buddyDimensions) — sized up 40% per Destin.
        width: 112,
        height: 112,
        // NOTE: we deliberately do NOT set -webkit-app-region: drag here.
        // On Windows, Electron implements drag regions via WM_NCHITTEST →
        // HTCAPTION, which makes the OS consume ALL pointer events for
        // window dragging — pointerdown/up never reach React and the click
        // handler never fires. Instead we drive drag ourselves via the
        // buddy.moveMascot IPC (main-process setPosition with clamping).
        cursor: grabbed ? 'grabbing' : 'grab',
        background: 'transparent',
        // touchAction: 'none' lets us capture the pointer cleanly without
        // the browser's default scroll/pan gestures interfering.
        touchAction: 'none',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onLostPointerCapture={onLostPointerCapture}
      onPointerCancel={onPointerCancel}
      onPointerEnter={onPointerEnter}
    >
      {/* Sink layer: dock/peek transforms + the side-peek lean (independent
          `rotate` so it composes with the wrapper's hover/grab `scale` and
          the flat-art breathing `translate`). data-attrs → buddy.css. */}
      <div
        className="mascot-sink"
        data-dock-mode={peeking ? 'peeking' : dock.mode}
        data-dock-edge={dock.edge ?? ''}
        data-swing={swing ?? ''}
      >
        {/* Lean layer: the side-peek ∓75° body lean lives on its OWN element
            INSIDE the sink translate — CSS resolves an element's `rotate`
            property BEFORE its `transform`, so rotate+translate on one element
            would swing the already-translated body around the stale center
            and out of the window (prototype splits the layers the same way). */}
        <div className="mascot-lean" style={{ width: '100%', height: '100%' }}>
          <div key={bounceKey} className={attention && !reducedEffects ? 'mascot-bounce' : ''} style={{ width: '100%', height: '100%' }}>
            {useRig ? (
              <div ref={rigHostRef} style={{ width: '100%', height: '100%' }}>
                <MascotRig svgUrl={rigUrl} pose={pose} motionRef={motionRef} reducedEffects={reducedEffects} />
              </div>
            ) : (
              <img
                src={flatMascot!}
                alt=""
                style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
                // Dragging an <img> would otherwise start an HTML drag. Disable.
                draggable={false}
              />
            )}
          </div>
        </div>
      </div>
      {/* Side-peek grip mittens: pinned at the window's edge-side boundary,
          OUTSIDE the sink/lean transforms — the hands stay planted on the
          screen edge while the body sags between them (spec §6.2 "75° wider").
          Rig-only; flat art degrades to the sink alone. */}
      {useRig && sidePeek && (
        <PeekHands side={dock.edge as 'left' | 'right'} rigHostRef={rigHostRef} />
      )}
    </div>
  );
}

/**
 * Clones the rig's `rig-hand-peek-<side>` mitten art into two edge-pinned
 * overlay SVGs (staggered grips, slight opposing tilts — the approved "75°
 * wider" staging: grip gap ≈ 0.73 × mascot size). Renders nothing when the
 * rig has no peek-hand group — sink-only degradation per the plan.
 */
function PeekHands({ side, rigHostRef }: { side: 'left' | 'right'; rigHostRef: React.RefObject<HTMLDivElement | null> }) {
  const [handSvg, setHandSvg] = useState<string | null>(null);

  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    let attempts = 0;
    const tryExtract = () => {
      const svg = rigHostRef.current?.querySelector('svg');
      const hand = svg?.querySelector<SVGGElement>(`#rig-hand-peek-${side}`) ?? null;
      if (!svg || !hand) {
        // The rig fetch/sanitize may not have resolved yet (e.g., the buddy
        // boots straight into a persisted peek) — retry briefly, then give
        // up: a rig without peek-hand groups degrades to the sink alone.
        setHandSvg(null);
        if (attempts++ < 20) timer = setTimeout(tryExtract, 250);
        return;
      }
      // The hand group ships display:none (only the app's overlay shows it).
      // getBBox needs a rendered box — flip display on synchronously, measure,
      // flip back; no paint happens inside one JS task, so nothing flashes.
      const prevDisplay = hand.style.display;
      hand.style.display = '';
      let bbox: DOMRect | null = null;
      try { bbox = hand.getBBox(); } catch { /* detached/unrenderable — degrade */ }
      hand.style.display = prevDisplay;
      if (!bbox || !bbox.width || !bbox.height) { setHandSvg(null); return; }
      const clone = hand.cloneNode(true) as SVGGElement;
      clone.style.display = '';
      clone.removeAttribute('id'); // no duplicate ids in the document
      const pad = 0.4; // breathing room for the stroke
      // Content comes from the already-sanitized inlined rig — safe to re-inline.
      setHandSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bbox.x - pad} ${bbox.y - pad} ${bbox.width + pad * 2} ${bbox.height + pad * 2}" width="100%" height="100%">${clone.outerHTML}</svg>`,
      );
    };
    tryExtract();
    return () => { if (timer) clearTimeout(timer); };
  }, [side, rigHostRef]);

  if (!handSvg) return null;
  // Grip geometry in fractions of the 80px window (workbench values / 230):
  // mitten width 0.15, centers at mid ± gap/2 with gap 0.73.
  const mitten = (centerFrac: number, tilt: number) => (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        [side]: 0,
        top: `${(centerFrac - 0.075) * 100}%`,
        width: '15%',
        height: '15%',
        rotate: `${tilt}deg`,
        pointerEvents: 'none',
      }}
      dangerouslySetInnerHTML={{ __html: handSvg }}
    />
  );
  return (
    <>
      {mitten(0.5 - 0.365, side === 'right' ? -4 : 4)}
      {mitten(0.5 + 0.365, side === 'right' ? 4 : -4)}
    </>
  );
}
