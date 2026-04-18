import { useCallback, useRef } from 'react';
import type { MascotVariant } from '../../themes/theme-types';
import { useThemeMascot } from '../../hooks/useThemeMascot';
import { useAnyAttentionNeeded } from '../../hooks/useAnyAttentionNeeded';

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
  // use the standard 'idle' variant. Theme authors provide mascot assets via
  // mascot-shocked.svg, or fallback to emoji.
  const variant: MascotVariant = attention ? 'shocked' : 'idle';
  const customMascot = useThemeMascot(variant);

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
        <DefaultMascot variant={attention ? 'shocked' : 'idle'} />
      )}
    </div>
  );
}

/**
 * Fallback when the active theme has no mascot override for the current
 * variant. Uses emoji to keep the MVP simple; themes that want branded
 * mascots provide their own idle/welcome assets via useThemeMascot.
 */
function DefaultMascot({ variant }: { variant: 'idle' | 'shocked' }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        fontSize: 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none',
        // pointer-events:none so clicks still reach the parent drag-handler
        // div. Without this, clicks on the emoji land on this child and the
        // parent's pointerdown never fires.
        pointerEvents: 'none',
      }}
    >
      {variant === 'shocked' ? '😲' : '🐱'}
    </div>
  );
}
