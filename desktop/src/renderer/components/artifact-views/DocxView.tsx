import { useEffect, useState } from 'react';
import type { ArtifactViewProps } from './types';
import { BinaryContent, CenterNote } from './BinaryContent';

// @ts-ignore mammoth.browser lacks type declarations
import mammoth from 'mammoth/mammoth.browser';

export function DocxView({ absolutePath }: ArtifactViewProps) {
  // BinaryContent owns loading/error for the byte read and remounts the inner
  // component per file, so html/parseError can't go stale across switches.
  return (
    <BinaryContent absolutePath={absolutePath} noun="document">
      {(bytes) => <DocxContent bytes={bytes} />}
    </BinaryContent>
  );
}

function DocxContent({ bytes }: { bytes: Uint8Array }) {
  const [html, setHtml] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // mammoth wants an ArrayBuffer; pass the bytes' underlying buffer.
    mammoth
      .convertToHtml({ arrayBuffer: bytes.buffer })
      .then((result: any) => { if (!cancelled) setHtml(result.value); })
      .catch((e: any) => { if (!cancelled) setParseError(String(e?.message ?? e)); });
    return () => { cancelled = true; };
  }, [bytes]);

  if (parseError) return <CenterNote>Couldn’t open this document.</CenterNote>;
  if (html === null) return <CenterNote>Loading document…</CenterNote>;

  return (
    <div
      className="overflow-auto h-full p-4 prose dark:prose-invert max-w-none"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
