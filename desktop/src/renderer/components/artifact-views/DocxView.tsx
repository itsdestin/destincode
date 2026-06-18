import { useEffect, useState } from 'react';
import type { ArtifactViewProps } from './types';
import { useArtifactBytes } from './useArtifactBytes';

// @ts-ignore mammoth.browser lacks type declarations
import mammoth from 'mammoth/mammoth.browser';

export function DocxView({ absolutePath }: ArtifactViewProps) {
  const { bytes, loading, error } = useArtifactBytes(absolutePath);
  const [html, setHtml] = useState<string>('');
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
    // mammoth wants an ArrayBuffer; pass the bytes' underlying buffer.
    mammoth
      .convertToHtml({ arrayBuffer: bytes.buffer })
      .then((result: any) => { if (!cancelled) setHtml(result.value); })
      .catch((e: any) => { if (!cancelled) setParseError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [bytes]);

  if (loading) return <div className="flex items-center justify-center h-full text-fg-muted text-sm">Loading document…</div>;
  if (error || parseError) return <div className="flex items-center justify-center h-full text-fg-muted text-sm p-4">Couldn’t open this document.</div>;

  return (
    <div
      className="overflow-auto h-full p-4 prose dark:prose-invert max-w-none"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
