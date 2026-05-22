import { useEffect, useState } from 'react';
import type { ArtifactViewProps } from './types';

// @ts-ignore mammoth.browser lacks type declarations
import mammoth from 'mammoth/mammoth.browser';

export function DocxView({ absolutePath }: ArtifactViewProps) {
  const [html, setHtml] = useState<string>('');
  useEffect(() => {
    let cancelled = false;
    fetch(`file://${absolutePath}`)
      .then((r) => r.arrayBuffer())
      .then((buf) => mammoth.convertToHtml({ arrayBuffer: buf }))
      .then((result) => { if (!cancelled) setHtml(result.value); });
    return () => { cancelled = true; };
  }, [absolutePath]);
  return (
    <div
      className="overflow-auto h-full p-4 prose dark:prose-invert max-w-none"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
