import { useCallback, useRef } from 'react';
import type { MascotVariant } from '../../themes/theme-types';
import { useThemeMascot } from '../../hooks/useThemeMascot';
import { useAnyAttentionNeeded } from '../../hooks/useAnyAttentionNeeded';
import { WelcomeAppIcon } from '../Icons';

const DRAG_THRESHOLD_PX = 4;

// Pointer-driven drag state. We track screen-space deltas (not client coords)
// because the window moves during the drag, which would invalidate any
// client-space math.
interface DragState {
  lastX: number;
  lastY: number;
  totalTravel: number;
  pointerId: number;
}

export function BuddyMascot() {
  const attention = useAnyAttentionNeeded();
  // When attention is needed, use the theme's 'shocked' variant. When idle,
  // use the standard 'idle' variant. If the active theme only ships a
  // 'welcome' mascot (very common — main's launch screen uses it) fall
  // through to that so every theme gets a themed mascot instead of a cat
  // emoji. Themes that ship neither fall through to the YouCoded-branded
  // <WelcomeAppIcon/> SVG, which picks up the theme's text-fg-dim color.
  const variant: MascotVariant = attention ? 'shocked' : 'idle';
  const variantMascot = useThemeMascot(variant);
  const welcomeMascot = useThemeMascot('welcome');
  const customMascot = variantMascot ?? welcomeMascot;

  const dragRef = useRef<DragState | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // setPointerCapture keeps pointermove/up flowing even if the pointer
    // leaves the 80×80 window during a fast drag.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    dragRef.current = {
      lastX: e.screenX,
      lastY: e.screenY,
      totalTravel: 0,
      pointerId: e.pointerId,
    };
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragRef.current;
    if (!st) return;
    const dx = e.screenX - st.lastX;
    const dy = e.screenY - st.lastY;
    if (dx === 0 && dy === 0) return;
    st.lastX = e.screenX;
    st.lastY = e.screenY;
    st.totalTravel += Math.abs(dx) + Math.abs(dy);
    // Only start forwarding moves once we've crossed the click-vs-drag
    // threshold, so a jittery click doesn't nudge the window by a pixel.
    if (st.totalTravel > DRAG_THRESHOLD_PX) {
      window.claude?.buddy?.moveMascot?.({ dx, dy });
    }
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragRef.current;
    dragRef.current = null;
    if (!st) return;
    try { e.currentTarget.releasePointerCapture(st.pointerId); } catch { /* ignore */ }
    if (st.totalTravel <= DRAG_THRESHOLD_PX && window.claude?.buddy?.toggleChat) {
      window.claude.buddy.toggleChat();
    }
  }, []);

  return (
    <div
      style={{
        width: 80,
        height: 80,
        // NOTE: we deliberately do NOT set -webkit-app-region: drag here.
        // On Windows, Electron implements drag regions via WM_NCHITTEST →
        // HTCAPTION, which makes the OS consume ALL pointer events for
        // window dragging — pointerdown/up never reach React and the click
        // handler never fires. Instead we drive drag ourselves via the
        // buddy.moveMascot IPC (main-process setPosition with clamping).
        cursor: 'grab',
        background: 'transparent',
        // touchAction: 'none' lets us capture the pointer cleanly without
        // the browser's default scroll/pan gestures interfering.
        touchAction: 'none',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {customMascot ? (
        <img
          src={customMascot}
          alt=""
          style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
          // Dragging an <img> would otherwise start an HTML drag. Disable.
          draggable={false}
        />
      ) : (
        // Final fallback: the YouCoded-branded glyph. `text-fg-dim` picks up
        // the active theme's dimmed foreground color, so the icon tints to
        // whatever theme is active — no cat emoji. Pointer-events none so
        // clicks reach the parent drag-handler div.
        // For the attention/shocked state, wrap in a soft pulse so the
        // fallback still signals "something needs you" without shipping
        // per-theme artwork.
        <WelcomeAppIcon
          className={`w-full h-full text-fg-dim${attention ? ' animate-pulse' : ''}`}
        />
      )}
    </div>
  );
}
