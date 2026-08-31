// The session pill's name label: how wide it is and how it gets there.
//
// Extracted from SessionStrip.tsx (was inline at :892-896) because the two
// causes of the 2026-08-31 "active pill snaps open" bug both lived in this one
// expression and neither was reachable by a test while it sat in JSX.
//
// WHY calc-size(): a plain `max-width: 0 -> 120px` transition gives every name
// the same travel distance regardless of how long it is, so a short name
// reaches its real size early and then sits still. calc-size() lets the
// browser interpolate to the label's INTRINSIC width, which `max-width` cannot
// do without imposing a hard cap. calc-size() needs Chromium 129; this app
// runs Electron 41.10.3, comfortably past it (the exact Chromium number is not
// worth pinning here — it moves every release and only the floor matters).
// If it ever has to be reverted, the fallback is animating
// `grid-template-columns: 0fr -> 1fr` on a wrapper element (one extra DOM node
// per pill, and the grid item needs `min-width: 0` or 0fr clamps to min-content).
import type React from 'react';

/** How wide a NON-active pill's name may get on hover. The active pill is
 *  uncapped: it flex-shrinks and ellipsises only when the strip itself runs
 *  out of room, which is what makes the active session's name worth showing. */
export const HOVER_CAP_PX = 120;

export interface LabelStyleInput {
  /** The name is meant to be visible at all (hovered, pack-expanded, or active). */
  showName: boolean;
  isActive: boolean;
  /** `pack.expanded.has(id)` — the packer decided this pill shows its name. */
  packExpanded: boolean;
  /** True only inside the short window armed by a change of active session id. */
  animateExpand: boolean;
}

const REVEAL_TRANSITION =
  'width var(--dur-reveal) var(--ease-bounce), opacity var(--dur-hover) var(--ease-bounce)';

export function pillLabelStyle(input: LabelStyleInput): React.CSSProperties {
  const { showName, isActive, packExpanded, animateExpand } = input;

  const width = !showName
    ? '0px'
    : isActive
      ? 'calc-size(max-content, size)'
      : `calc-size(max-content, min(size, ${HOVER_CAP_PX}px))`;

  // `none` suppresses repack churn — without it every pill slides whenever the
  // packer reruns. But packSessions guarantees the active pill is ALWAYS
  // pack-expanded, so this same `none` silences the one pill the user just
  // clicked. The armed window is the narrow exception.
  const transition = packExpanded && !animateExpand ? 'none' : REVEAL_TRANSITION;

  return { width, opacity: showName ? 1 : 0, transition };
}
