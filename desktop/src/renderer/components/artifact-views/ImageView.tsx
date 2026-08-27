import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArtifactViewProps } from './types';
import { BinaryContent, CenterNote } from './BinaryContent';
import { ZoomPill } from '../ui';
import { Loupe, useZoomPan } from './zoom';
import { useEscClose } from '../../hooks/use-esc-close';

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};

/** Below this pane width the pill is wider than the picture it would sit on.
 *  The content pane can be ~107px (MIN_DRAWER_WIDTH 320 minus the 210px file
 *  list), so this is a real case, not a theoretical one. */
const MIN_WIDTH_FOR_PILL = 260;

export function ImageView({ absolutePath }: ArtifactViewProps) {
  // BinaryContent owns loading/error for the byte read.
  return (
    <BinaryContent absolutePath={absolutePath} noun="image">
      {(bytes) => <ImageContent bytes={bytes} absolutePath={absolutePath} />}
    </BinaryContent>
  );
}

// All zoom/loupe state lives HERE, not in ImageView: BinaryContent keys this
// child by absolutePath, so switching files remounts it and every file opens
// plainly at fit size. State one level up would carry a stale zoom across.
function ImageContent({ bytes, absolutePath }: { bytes: Uint8Array; absolutePath: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [loupeOn, setLoupeOn] = useState(false);

  const isSvg = absolutePath.toLowerCase().endsWith('.svg');
  // No hover, no lens: a magnifier that follows a cursor is meaningless without
  // one, and rendering a control that can do nothing is worse than omitting it.
  // A media query rather than a platform check — a remote browser on a desktop
  // has a real cursor and should get the lens.
  const canLoupe = typeof window !== 'undefined'
    && window.matchMedia?.('(hover: hover) and (pointer: fine)')?.matches === true;

  // Build a blob: URL from the bytes (same-origin, works everywhere) instead of
  // an <img src="file://…">, which the renderer origin can't load.
  useEffect(() => {
    const ext = absolutePath.split('.').pop()?.toLowerCase() ?? '';
    // base64ToBytes allocates an exact-size buffer, so .buffer is the full data.
    // Cast narrows ArrayBufferLike → ArrayBuffer for the strict BlobPart type.
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: MIME[ext] ?? 'application/octet-stream' });
    const objUrl = URL.createObjectURL(blob);
    setUrl(objUrl);
    return () => URL.revokeObjectURL(objUrl);
  }, [bytes, absolutePath]);

  // The drawer's resize handle writes --drawer-width straight to <html> with NO
  // React re-render (state/drawer-width.ts), so the container has to be observed
  // or the fit scale goes stale while the divider is being dragged.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [url]);

  // A vector's reported size is meaningless: a viewBox-only SVG reports
  // Chromium's 300×150 default whatever it actually draws (its RATIO is right,
  // its size is not). Left alone it renders as a small box in a big pane and the
  // lens suppresses itself for being smaller than the lens. So scale a vector up
  // to fill the pane at its own aspect ratio and treat THAT as its natural size.
  const content = (() => {
    if (!isSvg || !(natural.w > 0) || !(box.w > 0)) return natural;
    const up = Math.min(box.w / natural.w, box.h / natural.h);
    return { w: natural.w * up, h: natural.h * up };
  })();

  const zoom = useZoomPan({
    containerW: box.w, containerH: box.h, contentW: content.w, contentH: content.h,
  });

  // Escape rides the app's dismissal stack. A raw keydown listener here would
  // either swallow the Escape that interrupts Claude or fire alongside it, and
  // Android's hardware back button routes through this same stack.
  useEscClose(loupeOn, () => setLoupeOn(false));

  const resolveSource = useCallback(
    () => (imgRef.current ? { el: imgRef.current } : null),
    [],
  );

  if (!url) return <CenterNote>Loading image…</CenterNote>;

  return (
    <div
      ref={boxRef}
      data-zoomable
      className="relative h-full w-full overflow-hidden"
      // Only claim the touch gestures once there is something to pan; at fit the
      // page keeps its normal scrolling behaviour.
      style={{ touchAction: zoom.isFit ? undefined : 'none' }}
      {...zoom.bind}
    >
      <img
        ref={imgRef}
        src={url}
        alt=""
        draggable={false}
        onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        className="absolute left-1/2 top-1/2 max-w-none select-none"
        style={{
          // Explicit size, so the element's CSS box always equals the content
          // box. The lens draws from this element, so any mismatch (an
          // object-contain letterbox, a vector at its default size) would
          // magnify something different from what is on screen.
          width: content.w || undefined,
          height: content.h || undefined,
          // translate(-50%,-50%) centres it, then pan and scale ride on top. A
          // transform creates no scroll extent, which is exactly why dragging is
          // the only way to pan and why zoom-math clamps the offset.
          transform:
            `translate(-50%, -50%) translate(${zoom.offset.x}px, ${zoom.offset.y}px) scale(${zoom.scale})`,
          transformOrigin: 'center',
          cursor: zoom.isFit ? undefined : (zoom.dragging ? 'grabbing' : 'grab'),
        }}
      />

      {/* `box.w > 0 &&` matters: before the first measurement the width is 0 and
          we do NOT yet know it is narrow. Treating unknown as narrow would hide
          the pill on first paint and flash it in a frame later, on every file. */}
      {!(box.w > 0 && box.w < MIN_WIDTH_FOR_PILL) && (
        <ZoomPill
          className="absolute top-2 left-2"
          percent={zoom.percent}
          canZoomIn={zoom.canZoomIn}
          canZoomOut={zoom.canZoomOut}
          onZoomIn={zoom.zoomIn}
          onZoomOut={zoom.zoomOut}
          onReset={zoom.reset}
          loupe={canLoupe ? { on: loupeOn, onToggle: () => setLoupeOn((v) => !v) } : null}
        />
      )}

      {loupeOn && (
        <Loupe resolveSource={resolveSource} displayScale={zoom.scale} vector={isSvg} />
      )}
    </div>
  );
}
