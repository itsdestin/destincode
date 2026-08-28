import { useEffect, useRef, type RefObject } from 'react';
import { OverlayPanel } from '../../overlays/Overlay';
import { pointInRect } from './zoom-math';

/** Lens diameter in CSS pixels. Also the floor for showing it at all: a source
 *  smaller than the lens has nothing to reveal. */
export const LOUPE_DIAMETER = 180;

/** A small crosshair at the lens centre marking the EXACT point being magnified.
 *  The mouse cursor itself is drawn by the operating system on top of the whole
 *  window, so it is never hidden by the lens — but it sits over a magnified
 *  image, and without a mark it is ambiguous which pixel it is actually on.
 *  Drawn as a dark stroke under a light one so it reads on any picture. */
function drawCentreMark(ctx: CanvasRenderingContext2D, c: number) {
  const arm = 7;
  const gap = 3;
  for (const [width, colour] of [[3, 'rgba(0,0,0,0.55)'], [1, 'rgba(255,255,255,0.95)']] as const) {
    ctx.lineWidth = width;
    ctx.strokeStyle = colour;
    ctx.beginPath();
    ctx.moveTo(c - arm - gap, c); ctx.lineTo(c - gap, c);
    ctx.moveTo(c + gap, c); ctx.lineTo(c + arm + gap, c);
    ctx.moveTo(c, c - arm - gap); ctx.lineTo(c, c - gap);
    ctx.moveTo(c, c + gap); ctx.lineTo(c, c + arm + gap);
    ctx.stroke();
  }
}

/** Is a modal scrim actually SHOWING?
 *
 *  Not "does one exist": a scrim element stays mounted at all times and fades in
 *  and out, so testing for its presence hid the lens permanently — the magnifier
 *  stopped working entirely (2026-08-27). Only a painted scrim means something
 *  is over the viewer. */
function scrimIsUp(): boolean {
  for (const el of Array.from(document.querySelectorAll('.layer-scrim'))) {
    const cs = getComputedStyle(el);
    if (cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.01) return true;
  }
  return false;
}

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
  /** The element that VISUALLY CLIPS the content — the pane's overflow box.
   *  Required whenever the source can be bigger than what is on screen, which
   *  is any zoomed picture or PDF page. See rule 5 below. */
  clipTo?: RefObject<HTMLElement | null>;
}

/**
 * Cursor-following magnifier.
 *
 * Five rules here are load-bearing, each one a measured failure if broken:
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
 * 5. The pointer must be inside `clipTo` as well as inside the source. A
 *    zoomed picture is far larger than its pane and is only trimmed by CSS
 *    `overflow: hidden`; getBoundingClientRect still reports the WHOLE untrimmed
 *    box. Hit-testing the source alone therefore put the lens out over the chat
 *    pane, magnifying image margin that was not on screen (reported 2026-08-27).
 *
 * It never calls getImageData/toDataURL. A display-only draw is unaffected by
 * canvas tainting; read-back is the thing tainting blocks.
 */
export function Loupe({
  resolveSource, displayScale, diameter = LOUPE_DIAMETER, magnification = 2.5, vector = false,
  clipTo,
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

      // Something is over the viewer? Do not paint. A dialog lays a scrim across
      // the whole app (Overlay.tsx's .layer-scrim) and the lens kept tracking and
      // rendering behind the blur (reported 2026-08-27). It HIDES rather than
      // switching the mode off, so closing the dialog resumes where you were.
      //
      // NOT also gated on document.hasFocus(): that is false for any document
      // that does not hold focus — including the workbench's iframe and a
      // headless page — so it would silently disable the lens in places where it
      // should work. Window-level focus is a different question from this one.
      if (scrimIsUp()) {
        lens.style.visibility = 'hidden';
        return;
      }

      const p = pointer.current;
      // Controls first: a lens sitting on top of the button that turns it off is
      // a trap, and the same applies to the find bar. Any control that must stay
      // usable under an open lens marks itself `data-loupe-block`.
      if (p) {
        for (const el of Array.from(document.querySelectorAll('[data-loupe-block]'))) {
          if (pointInRect(p.x, p.y, el.getBoundingClientRect())) {
            lens.style.visibility = 'hidden';
            return;
          }
        }
      }
      // Outside the pane that clips the content, there is nothing on screen to
      // magnify — even though the source element's rect still extends out there.
      if (p && clipTo?.current && !pointInRect(p.x, p.y, clipTo.current.getBoundingClientRect())) {
        lens.style.visibility = 'hidden';
        return;
      }

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
      drawCentreMark(ctx, diameter / 2);
    });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerleave', onLeave);
    };
  }, [resolveSource, displayScale, diameter, magnification, vector, clipTo]);

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
