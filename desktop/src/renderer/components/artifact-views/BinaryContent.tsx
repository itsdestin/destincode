import React from 'react';
import { useArtifactBytes } from './useArtifactBytes';

// Shared loading/error shell for every binary viewer (pdf/docx/xlsx/image).
// Each viewer previously re-wired useArtifactBytes + its own loading/error
// branches — and PdfView forgot them entirely, leaving a permanently blank
// pane on a failed read. Centralizing the states here makes that bug class
// impossible: the inner viewer component only ever mounts with real bytes.
//
// The child is keyed by absolutePath so ALL of its internal state (parsed
// sheets, rendered html, selection, parse errors) resets when the user
// switches files — no stale-content flash from the previous document.

/** Map the read-binary error codes to a human message. */
function describeBytesError(error: string, noun: string): string {
  switch (error) {
    case 'orphan':
      return `This ${noun} no longer exists on disk.`;
    case 'too-large':
      return `This ${noun} is too large to preview — use “Open externally”.`;
    case 'not-allowed':
      return `This ${noun} is outside your project folders and can’t be previewed.`;
    case 'unavailable':
      return `Preview isn’t available on this platform.`;
    default:
      return `Couldn’t open this ${noun}.`;
  }
}

export function CenterNote({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-center h-full text-fg-muted text-sm p-4 text-center">{children}</div>;
}

export function BinaryContent({ absolutePath, noun, children }: {
  absolutePath: string;
  /** What to call the file in messages: "document", "image", "spreadsheet", "PDF". */
  noun: string;
  children: (bytes: Uint8Array) => React.ReactElement;
}) {
  const { bytes, loading, error } = useArtifactBytes(absolutePath);
  if (loading) return <CenterNote>Loading {noun}…</CenterNote>;
  if (error || !bytes) return <CenterNote>{describeBytesError(error ?? 'read-failed', noun)}</CenterNote>;
  return <React.Fragment key={absolutePath}>{children(bytes)}</React.Fragment>;
}
