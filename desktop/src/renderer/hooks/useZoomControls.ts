import { useState, useRef, useEffect, useCallback } from 'react';

// Zoom subsystem (Ctrl+/-/0, trackpad pinch, transient overlay state).
// Extracted from AppInner (tranche 1) — logic unchanged. The handler refs are
// assigned every render on purpose so the once-registered window listeners
// always see the latest callbacks without re-registering (App.tsx R8 pattern).
export function useZoomControls() {
  const [zoomPercent, setZoomPercent] = useState(100);
  const [zoomVisible, setZoomVisible] = useState(false);
  const zoomHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch actual zoom level on mount — Electron may have persisted a non-100% zoom
  useEffect(() => {
    (window as any).claude?.zoom?.get?.().then((p: number) => {
      if (p && p !== 100) setZoomPercent(p);
    }).catch(() => {});
  }, []);

  // --- Zoom controls (Ctrl+/-, Ctrl+0, trackpad pinch) ---
  const showZoom = useCallback((percent: number) => {
    setZoomPercent(percent);
    setZoomVisible(true);
    if (zoomHideTimer.current) clearTimeout(zoomHideTimer.current);
    zoomHideTimer.current = setTimeout(() => setZoomVisible(false), 1500);
  }, []);

  const handleZoomIn = useCallback(async () => {
    const percent = await (window as any).claude.zoom.zoomIn();
    showZoom(percent);
  }, [showZoom]);

  const handleZoomOut = useCallback(async () => {
    const percent = await (window as any).claude.zoom.zoomOut();
    showZoom(percent);
  }, [showZoom]);

  const handleZoomReset = useCallback(async () => {
    const percent = await (window as any).claude.zoom.reset();
    showZoom(percent);
  }, [showZoom]);

  // Refs so the event listeners always see the latest callbacks without re-registering
  const zoomInRef = useRef(handleZoomIn);
  const zoomOutRef = useRef(handleZoomOut);
  const zoomResetRef = useRef(handleZoomReset);
  zoomInRef.current = handleZoomIn;
  zoomOutRef.current = handleZoomOut;
  zoomResetRef.current = handleZoomReset;

  // Keyboard: Ctrl+Plus, Ctrl+Minus, Ctrl+0
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      // '+' comes as '=' on US keyboards (Shift not required), or '+' with Shift,
      // or via numpad ('+'). Ctrl+= is the standard "zoom in" shortcut.
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomInRef.current();
      } else if (e.key === '-') {
        e.preventDefault();
        zoomOutRef.current();
      } else if (e.key === '0') {
        e.preventDefault();
        zoomResetRef.current();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  // Trackpad pinch-to-zoom — Chromium/Electron fires wheel events with ctrlKey
  // set to true for pinch gestures. Debounce to avoid spamming IPC.
  const pinchAccumulator = useRef(0);
  const pinchFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // Only intercept pinch (ctrlKey) wheel events
      e.preventDefault();

      // Accumulate delta and flush after a short pause — prevents one pinch
      // gesture from firing dozens of IPC calls
      pinchAccumulator.current += e.deltaY;

      if (pinchFlushTimer.current) clearTimeout(pinchFlushTimer.current);
      pinchFlushTimer.current = setTimeout(async () => {
        const delta = pinchAccumulator.current;
        pinchAccumulator.current = 0;
        if (Math.abs(delta) < 5) return; // Ignore tiny jitter
        if (delta < 0) {
          zoomInRef.current();
        } else {
          zoomOutRef.current();
        }
      }, 50);
    };
    // Must use { passive: false } to allow preventDefault on wheel
    window.addEventListener('wheel', handler, { passive: false, capture: true });
    return () => window.removeEventListener('wheel', handler, true);
  }, []);

  return { zoomPercent, zoomVisible, handleZoomIn, handleZoomOut, handleZoomReset };
}
