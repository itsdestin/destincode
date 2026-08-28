import { useCallback, useMemo, useRef, useState } from 'react';
import type React from 'react';
import {
  clampOffset, fitScale, ladderFor, stepScale, zoomAtPoint, type Offset, type Sizes,
} from './zoom-math';

/** A press only becomes a pan after this much travel, so a slightly shaky click
 *  is still a click and never nudges the picture. */
export const DRAG_THRESHOLD_PX = 4;

/**
 * Zoom + pan state for a picture-like artifact. Knows nothing about images or
 * PDFs: it is handed the container and content sizes and returns a scale, an
 * offset, and the handlers to bind.
 *
 * Scale is stored as `null` while the view is FITTED. That is what lets a pane
 * resize re-fit automatically — storing the resolved number instead would strand
 * the picture at whatever fit meant before the drawer was dragged.
 */
export function useZoomPan(sizes: Sizes) {
  const fit = fitScale(sizes);
  const [scale, setScale] = useState<number | null>(null);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  // Clamped to fit at READ time, not only when set: widening the pane raises the
  // fit scale, and a scale stored before that can end up BELOW it — leaving the
  // picture smaller than fitted with "zoom out" still offered.
  const current = Math.max(fit, scale ?? fit);
  const rungs = useMemo(() => ladderFor(fit), [fit]);
  const ceiling = rungs.length ? rungs[rungs.length - 1] : fit;

  const drag = useRef<{ id: number; startX: number; startY: number; base: Offset; live: boolean } | null>(null);
  // Two-pointer pinch. Android disables WebView zoom (WebViewHost.kt) and both
  // index.html copies ship user-scalable=no, so there is no native pinch to
  // conflict with — this is the only pinch a phone gets.
  const pinch = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStart = useRef<{ dist: number; scale: number } | null>(null);

  const applyScale = useCallback((next: number, anchor?: { x: number; y: number }) => {
    const clamped = Math.max(fit, Math.min(ceiling, next));
    // Storing null at fit keeps "fitted" a state rather than a coincidence of
    // numbers, so a later resize re-fits instead of holding a stale scale.
    const store = clamped <= fit + 1e-6 ? null : clamped;
    if (!anchor) {
      setScale(store);
      setOffset((o) => clampOffset(o, clamped, sizes));
      return;
    }
    const res = zoomAtPoint({ scale: current, offset }, clamped, anchor, sizes);
    setScale(res.scale <= fit + 1e-6 ? null : res.scale);
    setOffset(res.offset);
  }, [current, offset, fit, ceiling, sizes]);

  const zoomIn = useCallback(() => applyScale(stepScale(current, fit, 1)), [applyScale, current, fit]);
  const zoomOut = useCallback(() => applyScale(stepScale(current, fit, -1)), [applyScale, current, fit]);
  const reset = useCallback(() => { setScale(null); setOffset({ x: 0, y: 0 }); }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    pinch.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current.size === 2) {
      const [a, b] = [...pinch.current.values()];
      pinchStart.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: current };
      drag.current = null;      // a second finger ends any drag in progress
      return;
    }
    if (current <= fit + 1e-6) return;   // nothing to pan while fitted
    // A press that STARTS on a control is not a drag. Without this the pan
    // capture below swallowed the button's own click: pressing "+" bubbled to
    // this handler, the container captured the pointer, and the button never saw
    // the pointerup — so zoom worked exactly once and then every button in the
    // pill was dead (reported 2026-08-27: "goes from 12 to 50 and then freezes").
    // Only reachable above fit, which is why the FIRST click always worked.
    if ((e.target as Element | null)?.closest?.('[data-loupe-block], button, input, a')) return;
    drag.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, base: offset, live: false };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  }, [current, fit, offset]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (pinch.current.has(e.pointerId)) pinch.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinchStart.current && pinch.current.size === 2) {
      const [a, b] = [...pinch.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist > 0 && pinchStart.current.dist > 0) {
        const rect = (e.currentTarget as Element).getBoundingClientRect();
        applyScale(pinchStart.current.scale * (dist / pinchStart.current.dist), {
          x: (a.x + b.x) / 2 - rect.left,
          y: (a.y + b.y) / 2 - rect.top,
        });
      }
      return;
    }
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.live && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    d.live = true;
    setDragging(true);
    setOffset(clampOffset({ x: d.base.x + dx, y: d.base.y + dy }, current, sizes));
  }, [applyScale, current, sizes]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    // Hand the pointer back explicitly rather than relying on the implicit
    // release, so nothing downstream is left waiting on a captured pointer.
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    pinch.current.delete(e.pointerId);
    if (pinch.current.size < 2) pinchStart.current = null;
    if (drag.current?.id === e.pointerId) drag.current = null;
    setDragging(false);
  }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey) return;   // plain wheel belongs to the viewer (pan or scroll)
    // The app-wide pinch handler bails out inside [data-zoomable]
    // (hooks/useZoomControls.ts), so this is the only zoom that runs over a
    // picture. Without that guard both would fire and one gesture would resize
    // the app and the image together.
    const rect = (e.currentTarget as Element).getBoundingClientRect();
    applyScale(current * Math.exp(-e.deltaY / 300), {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  }, [applyScale, current]);

  return {
    scale: current,
    fit,
    isFit: current <= fit + 1e-6,
    percent: Math.round(current * 100),
    canZoomIn: current < ceiling - 1e-6,
    canZoomOut: current > fit + 1e-6,
    offset,
    dragging,
    zoomIn,
    zoomOut,
    reset,
    bind: { onPointerDown, onPointerMove, onPointerUp, onWheel },
  };
}
