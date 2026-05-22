import { useEffect, useRef } from 'react';
import * as pdfjs from 'pdfjs-dist';
import 'pdfjs-dist/build/pdf.worker.min.js';
import type { ArtifactViewProps } from './types';

export function PdfView({ absolutePath }: ArtifactViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const loadingTask = pdfjs.getDocument(`file://${absolutePath}`);
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
  }, [absolutePath]);

  return <div ref={containerRef} className="overflow-auto h-full p-4" />;
}
