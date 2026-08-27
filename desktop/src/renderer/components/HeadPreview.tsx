// HeadPreview — the two ways a small tile shows the first bytes of a text
// file. Shared by the composer's attachment cards (AttachmentChip) and the
// Project View / deliverables / tool-card thumbnail (ArtifactThumbnail) so
// every tile in the app previews a file the same way.
//
// Destin's rule (2026-08-27, ledger P-19): a markdown preview is RENDERED
// markdown — headings, bold, lists — never the raw `##`. So the markdown
// branch runs the app's real chat renderer (MarkdownContent) and scales the
// result down, rather than reinventing a "mini markdown" that would drift.
import React from 'react';
import MarkdownContent from './MarkdownContent';

interface MarkdownProps {
  /** The file head (a few hundred bytes — the caller caps it). */
  text: string;
  /** Shrink factor for the rendered page. 0.6 keeps an h2 legible in a 128px card. */
  scale?: number;
  className?: string;
}

/** Rendered markdown, scaled to fit the tile. Decorative and inert: it is
 *  aria-hidden (the tile's name strip is the accessible label), pointer-events
 *  are off so clicks reach the tile, and `inert` keeps the Copy button
 *  MarkdownContent puts on code blocks out of the tab order. */
export function MarkdownHeadPreview({ text, scale = 0.6, className = '' }: MarkdownProps) {
  // The inner box is laid out at 1/scale of the tile so that, once scaled,
  // it fills the tile exactly instead of leaving a scaled-down gap.
  const inverse = `${(100 / scale).toFixed(3)}%`;
  return (
    <div className={`h-full w-full overflow-hidden ${className}`} aria-hidden="true" data-testid="markdown-head-preview">
      <div
        inert
        className="origin-top-left pointer-events-none select-none text-fg text-sm text-left px-2 pt-1.5 [&>:first-child]:mt-0"
        style={{ transform: `scale(${scale})`, width: inverse, height: inverse }}
      >
        <MarkdownContent content={text} />
      </div>
    </div>
  );
}

/** Plain text / code: the first lines in a tiny mono block, clipped to the
 *  tile. `whitespace-pre` on purpose — wrapped code reads as noise at 10px. */
export function MonoHeadPreview({ text, className = '' }: { text: string; className?: string }) {
  return (
    <pre
      aria-hidden="true"
      data-testid="mono-head-preview"
      className={`m-0 h-full w-full overflow-hidden whitespace-pre font-mono text-3xs leading-tight text-fg-dim text-left px-1.5 pt-1 ${className}`}
    >
      {text}
    </pre>
  );
}
