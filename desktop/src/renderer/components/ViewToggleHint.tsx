import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { OverlayPanel, CONTENT_Z } from './overlays/Overlay';
import { CloseButton } from './ui';

/**
 * Coach mark that points at the chat/terminal toggle.
 *
 * WHY: the "Initializing session…" overlay's slow warning now sends the user to
 * terminal view with one button. That is a one-way door unless they already know
 * where the toggle is — the overlay was the only thing naming it, and it is gone
 * the moment the view switches. This is the way back, pointed straight at the
 * control.
 *
 * It anchors to whatever carries `data-view-toggle` (the wide segmented pill and
 * the narrow single-icon button both do), so it follows the toggle across the
 * narrow breakpoint and across platforms — on macOS the toggle sits in a
 * different header cluster than it does on Windows/Linux, and neither position
 * is hardcoded here.
 */

/** Marks the element this hint points at. Both toggle variants carry it. */
export const VIEW_TOGGLE_ANCHOR_ATTR = 'data-view-toggle';

const GAP_PX = 8;      // vertical distance from the toggle to the bubble
const MARGIN_PX = 8;   // minimum distance from the window edges
const ARROW_PX = 10;

interface Props {
  /** The ✕. Auto-dismissal on switching back to chat is the caller's job. */
  onDismiss: () => void;
}

type Geometry = { top: number; left: number; arrowLeft: number };

export default function ViewToggleHint({ onDismiss }: Props) {
  const [geo, setGeo] = useState<Geometry | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const anchor = document.querySelector(`[${VIEW_TOGGLE_ANCHOR_ATTR}]`);
    const panel = panelRef.current;
    if (!anchor || !panel) { setGeo(null); return; }
    const a = anchor.getBoundingClientRect();
    // A detached or zero-sized toggle (mid-remount across the narrow
    // breakpoint) would pin the bubble to the top-left corner. Skip the frame.
    if (a.width <= 0 || a.height <= 0) return;
    const width = panel.offsetWidth;
    const centre = a.left + a.width / 2;
    // The toggle sits close to the window edge on Windows/Linux, so a bubble
    // centred on it would hang off-screen. Clamp the box, then move the arrow
    // within it so it keeps pointing at the real centre.
    const maxLeft = Math.max(MARGIN_PX, window.innerWidth - width - MARGIN_PX);
    const left = Math.min(Math.max(centre - width / 2, MARGIN_PX), maxLeft);
    setGeo({ top: a.bottom + GAP_PX, left, arrowLeft: centre - left });
  }, []);

  useLayoutEffect(() => {
    measure();
    // The wide toggle animates its active label's width for 300ms on every
    // switch, and this mounts mid-animation — re-measure once it has settled.
    const settle = setTimeout(measure, 350);
    window.addEventListener('resize', measure);
    return () => { clearTimeout(settle); window.removeEventListener('resize', measure); };
  }, [measure]);

  // The header re-lays-out when session pills come and go, which moves the
  // toggle without a window resize.
  useEffect(() => {
    const anchor = document.querySelector(`[${VIEW_TOGGLE_ANCHOR_ATTR}]`);
    if (!anchor || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(anchor);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, [measure]);

  return createPortal(
    // Wrapper carries the layer, so the arrow (a sibling of the panel, because
    // .layer-surface clips its own children) can't fall behind the header.
    <div
      className="fixed"
      style={{
        top: geo?.top ?? 0,
        left: geo?.left ?? 0,
        zIndex: CONTENT_Z[4],
        // First paint happens before the panel can be measured; showing it then
        // would flash the bubble in the corner.
        visibility: geo ? 'visible' : 'hidden',
      }}
    >
      <div
        aria-hidden="true"
        className="absolute w-2.5 h-2.5 bg-panel border-l border-t border-edge rotate-45"
        style={{ left: (geo?.arrowLeft ?? 0) - ARROW_PX / 2, top: -ARROW_PX / 2 }}
      />
      <OverlayPanel
        ref={panelRef}
        layer={4}
        role="status"
        className="relative flex items-center gap-1.5 pl-3 pr-1 py-1.5 max-w-[calc(100vw-1rem)]"
      >
        <span className="text-2xs text-fg-2 leading-snug whitespace-nowrap">
          Click here to switch back to chat view
        </span>
        <CloseButton label="Dismiss hint" onClick={onDismiss} className="shrink-0" />
      </OverlayPanel>
    </div>,
    document.body,
  );
}
