import { useEffect, useRef } from 'react';
import { useArtifactBytes } from './useArtifactBytes';
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
  const containerRef = useRef<HTMLDivElement>(null);
  // Bytes come through IPC (renderer can't fetch file:// from its origin).
  const { bytes } = useArtifactBytes(absolutePath);

  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
    (async () => {
      // Copy into a fresh Uint8Array — pdfjs takes ownership of (detaches) the
      // buffer it's handed, which would break a re-render off the same bytes.
      const loadingTask = pdfjs.getDocument({ data: bytes.slice() });
      const pdf = await loadingTask.promise;
      if (cancelled) return;
      const container = containerRef.current;
      if (!container) return;
      container.innerHTML = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.maxWidth = '100%';
        canvas.style.marginBottom = '8px';
        container.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext('2d')!, viewport, canvas }).promise;
      }
    })();
    return () => { cancelled = true; };
  }, [bytes]);

  return <div ref={containerRef} className="overflow-auto h-full p-4" />;
}
