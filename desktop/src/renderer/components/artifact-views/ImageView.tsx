import { useEffect, useState } from 'react';
import type { ArtifactViewProps } from './types';
import { useArtifactBytes } from './useArtifactBytes';

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};

export function ImageView({ absolutePath }: ArtifactViewProps) {
  const { bytes, loading, error } = useArtifactBytes(absolutePath);
  const [url, setUrl] = useState<string | null>(null);

  // Build a blob: URL from the bytes (same-origin, works everywhere) instead of
  // an <img src="file://…">, which the renderer origin can't load.
  useEffect(() => {
    if (!bytes) { setUrl(null); return; }
    const ext = absolutePath.split('.').pop()?.toLowerCase() ?? '';
    // base64ToBytes allocates an exact-size buffer, so .buffer is the full data.
    // Cast narrows ArrayBufferLike → ArrayBuffer for the strict BlobPart type.
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: MIME[ext] ?? 'application/octet-stream' });
    const objUrl = URL.createObjectURL(blob);
    setUrl(objUrl);
    return () => URL.revokeObjectURL(objUrl);
  }, [bytes, absolutePath]);

  if (loading) return <div className="flex items-center justify-center h-full text-fg-muted text-sm">Loading image…</div>;
  if (error || !url) return <div className="flex items-center justify-center h-full text-fg-muted text-sm p-4">Couldn’t open this image.</div>;

  return (
    <div className="flex items-center justify-center h-full p-4 overflow-auto">
      <img src={url} alt="" className="max-w-full max-h-full" style={{ touchAction: 'pinch-zoom' }} />
    </div>
  );
}
