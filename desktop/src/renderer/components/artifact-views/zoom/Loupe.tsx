import { useEffect, useRef } from 'react';
import { OverlayPanel } from '../../overlays/Overlay';

/** Lens diameter in CSS pixels. Also the floor for showing it at all: a source
 *  smaller than the lens has nothing to reveal. */
export const LOUPE_DIAMETER = 180;

export interface LoupeSource { el: CanvasImageSource & Element }

export interface LoupeProps {
  /** The element under this client point, or null to hide the lens. A callback
   *  rather than a single element because a PDF is one canvas PER PAGE, and the
   *  page under the cursor changes as the user scrolls.
   *  (document.elementFromPoint is not an option — jsdom doesn't implement it,
   *  so anything built on it would be untestable.) */
  resolveSource(clientX: number, clientY: number): LoupeSource | null;
  /** Current display scale of the content, so magnification compounds correctly. */
  displayScale: number;
  diameter?: number;
  magnification?: number;
  /** True for vector sources (SVG): skips the raster "no more detail" clamp. */
  vector?: boolean;
}

/**
 * Cursor-following magnifier.
 *
 * Four rules here are load-bearing, each one a measured failure if broken:
 *
 * 1. It moves by writing a CSS transform through a ref, NOT via React state.
 *    State-per-pointermove re-renders the whole viewer on every pixel of cursor
 *    travel and visibly stutters on a large image.
 * 2. It redraws on requestAnimationFrame while open, not only on movement.
 *    Otherwise a stationary cursor over an animated GIF freezes the magnified
 *    copy while the picture underneath keeps playing.
 * 3. It draws with the DESTINATION-rect form of drawImage — the whole source
 *    scaled up and offset behind a circular clip — never the 9-argument
 *    source-sub-rect form. A viewBox-only SVG reports naturalWidth 300x150
 *    whatever its real size, and a source rect past naturalWidth returns fully
 *    transparent pixels: a blank lens. The destination form also lets the
 *    browser re-rasterize an SVG at the drawn size, so vectors stay sharp.
 * 4. All cursor-to-source maths is normalized against getBoundingClientRect.
 *    On Android and remote the app zoom is a CSS transform on <html>, so rects
 *    are ALREADY scaled — ratios cancel that out, absolute page coordinates
 *    would not.
 *
 * It never calls getImageData/toDataURL. A display-only draw is unaffected by
 * canvas tainting; read-back is the thing tainting blocks.
 */
export function Loupe({
  resolveSource, displayScale, diameter = LOUPE_DIAMETER, magnification = 2.5, vector = false,
}: LoupeProps) {
  const lensRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => { pointer.current = { x: e.clientX, y: e.clientY }; };
    const onLeave = () => { pointer.current = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerleave', onLeave);

    let raf = requestAnimationFrame(function draw() {
      raf = requestAnimationFrame(draw);
      const lens = lensRef.current;
      const canvas = canvasRef.current;
      if (!lens || !canvas) return;

      const p = pointer.current;
      const hit = p ? resolveSource(p.x, p.y) : null;
      if (!p || !hit) { lens.style.visibility = 'hidden'; return; }

      const rect = hit.el.getBoundingClientRect();
      if (rect.width < diameter || rect.height < diameter) {
        lens.style.visibility = 'hidden';
        return;
      }

      lens.style.visibility = 'visible';
      lens.style.transform = `translate(${p.x - diameter / 2}px, ${p.y - diameter / 2}px)`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;   // jsdom, and a real defense on a context-starved device

      // A raster source has a native resolution; magnifying past it only makes
      // bigger pixels. A vector source has none, so it magnifies freely.
      const naturalW = (hit.el as HTMLImageElement).naturalWidth || rect.width;
      const shownRatio = rect.width / naturalW;          // <1 when already downscaled
      const factor = vector
        ? magnification
        : Math.max(1, Math.min(magnification, (8 * shownRatio) / Math.max(displayScale, 0.01)));

      const w = rect.width * factor;
      const h = rect.height * factor;
      const nx = (p.x - rect.left) / rect.width;         // 0..1 across the source
      const ny = (p.y - rect.top) / rect.height;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(hit.el, diameter / 2 - nx * w, diameter / 2 - ny * h, w, h);
    });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerleave', onLeave);
    };
  }, [resolveSource, displayScale, diameter, magnification, vector]);

  return (
    <OverlayPanel
      layer={2}
      ref={lensRef}
      aria-hidden
      // L2 so the lens floats over the pill (L1) it was switched on from.
      className="fixed top-0 left-0 pointer-events-none p-0"
      style={{
        width: diameter,
        height: diameter,
        borderRadius: '50%',
        visibility: 'hidden',
        // The panel's own 1px --edge border disappears against image content —
        // the lens read as a vague change of scale rather than as a lens. A dark
        // ring plus a light inner hairline reads on both bright and dark
        // pictures, which a single colour cannot.
        boxShadow: '0 0 0 1px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.35), 0 6px 18px rgba(0,0,0,0.4)',
      }}
    >
      <canvas ref={canvasRef} width={diameter} height={diameter} />
    </OverlayPanel>
  );
}
