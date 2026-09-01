// src/renderer/dev/workbench/compare/Frame.tsx
//
// Mounts a candidate in the context its real counterpart would have. Judging a
// card against the wrong background is how a design looks right here and wrong
// in the app.
//
// Extracted from CompareView.tsx (where it lived as a local) when the live
// review route started rendering the same candidates one at a time: two copies
// of this would drift, and the whole promise of the compare registry is that a
// candidate looks identical wherever it is mounted.
import React from 'react';
import type { CompareFrame } from './types';

/** Pane width for a surface that declares no `paneWidth`. The review deck sizes
 *  its row on this same number (`scripts/ui-review/deck/live.py` → PANE_WIDTH in
 *  the youcoded-dev workspace), so the two must stay in step — a pane with no
 *  width at all stretches to fill whatever is around it, which is not the design
 *  being judged. */
export const PANE_WIDTH = 360;

export function Frame({ frame, width, children }: {
  frame: CompareFrame; width?: number; children: React.ReactNode;
}) {
  const style = width ? { width } : undefined;
  if (frame === 'panel') {
    // `.layer-surface` is the floating-surface treatment (panel fill, border,
    // shadow, wallpaper glass) — the same thing a Dialog gets. Rendering the
    // real Dialog here would not work: it is fixed-position, so all three
    // candidates would stack in the centre of the screen.
    return <div className="layer-surface overflow-hidden" style={style}>{children}</div>;
  }
  if (frame === 'inset') {
    return <div className="rounded-lg border border-edge-dim bg-inset overflow-hidden" style={style}>{children}</div>;
  }
  return <div style={style}>{children}</div>;
}
