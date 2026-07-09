import { useEffect, useRef, useState } from 'react';
import { BinaryContent, CenterNote } from './BinaryContent';
import * as pdfjs from 'pdfjs-dist';
// Fix: pdfjs-dist v5+ ships ESM-only workers (.mjs, not .js). Import via Vite's
// `?url` suffix so it's treated as a static asset URL rather than a bundled
// module — Vite can't bundle the worker as a regular import because rolldown
// can't resolve the .js path that no longer exists in the package.
// @ts-ignore — Vite ?url query suffix is not typed in this tsconfig (moduleResolution: node)
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl as string;
import type { ArtifactViewProps } from './types';

export function PdfView({ absolutePath }: ArtifactViewProps) {
  // BinaryContent owns loading/error for the byte read; PdfPages only ever
  // mounts with real bytes (and is remounted per file, resetting its state).
  return (
    <BinaryContent absolutePath={absolutePath} noun="PDF">
      {(bytes) => <PdfPages bytes={bytes} />}
    </BinaryContent>
  );
}

function PdfPages({ bytes }: { bytes: Uint8Array }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Copy into a fresh Uint8Array — pdfjs takes ownership of (detaches) the
    // buffer it's handed, which would break a re-render off the same bytes.
    const loadingTask = pdfjs.getDocument({ data: bytes.slice() });
    (async () => {
      const pdf = await loadingTask.promise;
      if (cancelled) return;
      const container = containerRef.current;
      if (!container) return;
      container.innerHTML = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        // Re-check per page — an unmount mid-render must not keep rasterizing
        // every remaining page into an orphaned DOM (heavy on large PDFs).
        if (cancelled) return;
        const page = await pdf.getPage(i);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.maxWidth = '100%';
        canvas.style.marginBottom = '8px';
        container.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext('2d')!, viewport, canvas }).promise;
      }
    })().catch((e: any) => {
      // Corrupt/encrypted PDFs reject here — surface a message instead of an
      // unhandled rejection + permanently blank pane.
      if (!cancelled) setParseError(String(e?.message ?? e));
    });
    return () => {
      cancelled = true;
      // destroy() aborts an in-flight load AND frees the worker transport for a
      // finished one — without it every file switch leaked the previous
      // document's memory in the pdf.js worker.
      loadingTask.destroy().catch(() => {});
    };
  }, [bytes]);

  if (parseError) return <CenterNote>Couldn’t open this PDF. It may be corrupt or password-protected.</CenterNote>;
  return <div ref={containerRef} className="overflow-auto h-full p-4" />;
}
