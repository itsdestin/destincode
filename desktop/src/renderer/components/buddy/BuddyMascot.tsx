import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from '../../state/theme-context';
import { useThemeMascot } from '../../hooks/useThemeMascot';
import { useAnyAttentionNeeded } from '../../hooks/useAnyAttentionNeeded';
import { MascotRig, type RigMotion } from '../mascot/MascotRig';
import type { PoseName } from '../mascot/mascot-poses';

const DRAG_THRESHOLD_PX = 4;
// Drag velocity is normalized to the 80px buddy-window scale before feeding
// the limb springs (spec §5: k = 80/size × 2.4) so trailing feels identical
// at any render size. The buddy window IS 80px, so the factor is the 2.4 gain.
const DRAG_VELOCITY_GAIN = 2.4;

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
  const prevDockRef = useRef<MascotDockState>({ mode: 'free', edge: null });
  useEffect(() => {
    const off = window.claude?.buddy?.onMascotState?.((s: MascotDockState) => {
      const prev = prevDockRef.current;
      prevDockRef.current = s;
      if (
        prev.mode === 'peeking' && (prev.edge === 'left' || prev.edge === 'right') &&
        s.mode !== 'peeking'
      ) {
        setSwing(prev.edge as 'left' | 'right');
        // Whip past vertical for ~230ms, then let the rotate transition settle to 0.
        setTimeout(() => setSwing(null), 230);
      }
      setDock(s);
    });
    return off;
  }, []);

  const sidePeek = dock.mode === 'peeking' && (dock.edge === 'left' || dock.edge === 'right');
  const pose: PoseName = attention
    ? 'shocked'
    : dock.mode === 'peeking'
      ? (dock.edge === 'left' ? 'peek-left' : dock.edge === 'right' ? 'peek-right' : 'peek')
      : 'idle';

  // Attention bounce: retrigger the CSS animation each time attention flips on.
  const [bounceKey, setBounceKey] = useState(0);
  useEffect(() => { if (attention) setBounceKey((k) => k + 1); }, [attention]);

  const [grabbed, setGrabbed] = useState(false);
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
        !useRig && !reducedEffects && !grabbed && dock.mode !== 'peeking' ? 'mascot-breathing' : '',
      ].filter(Boolean).join(' ')}
      style={{
        width: 80,
        height: 80,
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
      // Hover reveals the action bar: main coalesces mascot+bar hover with a
      // grace timeout (BarVisibilityTracker) to decide bar visibility. It's
      // also the dock 'activity' signal that slides a peeking mascot out.
      onPointerEnter={() => window.claude?.buddy?.reportHover?.({ source: 'mascot', hovering: true })}
      onPointerLeave={() => window.claude?.buddy?.reportHover?.({ source: 'mascot', hovering: false })}
    >
      {/* Sink layer: dock/peek transforms + the side-peek lean (independent
          `rotate` so it composes with the wrapper's hover/grab `scale` and
          the flat-art breathing `translate`). data-attrs → buddy.css. */}
      <div
        className="mascot-sink"
        data-dock-mode={dock.mode}
        data-dock-edge={dock.edge ?? ''}
        data-swing={swing ?? ''}
      >
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
    const svg = rigHostRef.current?.querySelector('svg');
    const hand = svg?.querySelector<SVGGElement>(`#rig-hand-peek-${side}`) ?? null;
    if (!svg || !hand) { setHandSvg(null); return; }
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
