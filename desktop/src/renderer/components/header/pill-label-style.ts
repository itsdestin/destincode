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

/** How wide a name may get when it is showing ONLY because you are pointing at
 *  it. A hover is a peek, and a very long name should not shove the row around
 *  under the cursor.
 *
 *  It is NOT a cap on pills the packer chose to expand: the packer measures the
 *  room a full name needs before expanding anything, so capping there clipped a
 *  name the strip had already made space for (measured 2026-08-31: a
 *  pack-expanded name clipped at exactly 120px with 137px of text, while its
 *  runtime badge kept 96px beside it). The active pill is likewise uncapped —
 *  it shrinks and ellipsises only when the strip itself runs out of room. */
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

// WIDTH IS NEVER ANIMATED ON AN OVERSHOOT CURVE. Width is a layout property:
// every sibling in the strip re-lays-out on every frame of it, so an overshoot
// sends the whole row past its destination and back. Measured 2026-08-31 on one
// session switch: the pill went 202.5 -> 261.9 -> 251.3 and every pill to its
// right slid 515.5 -> 583.4 -> 578.4. Overshoot belongs on `transform`, which
// moves nothing but itself. Guard: pill-label-style.test.ts → "never animates
// width on an overshoot curve".
const REVEAL_TRANSITION =
  'width var(--dur-reveal) var(--ease-out), opacity var(--dur-hover) var(--ease-out)';

export function pillLabelStyle(input: LabelStyleInput): React.CSSProperties {
  const { showName, isActive, packExpanded, animateExpand } = input;

  // Capped only when the name is a HOVER PEEK — i.e. neither the active pill
  // nor one the packer measured room for. See HOVER_CAP_PX.
  const hoverPeek = !isActive && !packExpanded;
  const width = !showName
    ? '0px'
    : hoverPeek
      ? `calc-size(max-content, min(size, ${HOVER_CAP_PX}px))`
      : 'calc-size(max-content, size)';

  // `none` suppresses repack churn — without it every pill slides whenever the
  // packer reruns. But packSessions guarantees the active pill is ALWAYS
  // pack-expanded, so this same `none` silences the one pill the user just
  // clicked. The armed window is the narrow exception.
  const transition = packExpanded && !animateExpand ? 'none' : REVEAL_TRANSITION;

  return { width, opacity: showName ? 1 : 0, transition };
}
