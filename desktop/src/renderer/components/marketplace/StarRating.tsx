// StarRating.tsx
// Pure presentational component. No hooks, no context, no side effects.
//
// Props:
//   value      — 0-5 rating (fractional allowed, e.g. 4.3)
//   count      — number of reviews
//   size       — "sm" for cards (small stars), "lg" for detail panels (larger stars)
//   hideCount  — when true, omits the "(N)" review-count suffix.
//                Used by ReviewList to show per-review stars without a count label.
//
// Renders null when count < 1 so callers don't see an orphaned 0-review row.
// Uses an inline filled+empty overlay technique: a clipping wrapper constrains
// a fully-filled star row to `value/5 * 100%`, overlaid on top of an empty row.
// This gives clean fractional fill without SVG clip-path complexity.

import React from 'react';

interface StarRatingProps {
  value: number;
  count: number;
  size: 'sm' | 'lg';
  /** Omit the "(N reviews)" suffix — used for per-review display in ReviewList. */
  hideCount?: boolean;
}

/**
 * Star gold. Deliberately a raw hex and NOT a theme token (ruling 2026-07-22,
 * spec §14.7): it isn't a status color carrying "caution" — it's the app-store
 * gold-star convention, which users read as "star rating" the way they read a
 * green dot as "online". There is no `--gold`/`--rating` token in any theme, so
 * the alternatives were `text-accent` (blue stars on Midnight, green on a green
 * pack — it changes what the control means) or inventing a token across 11
 * theme manifests plus the contrast audit, which is a change-36-scale project.
 *
 * Exported so the interactive stars in RatingSubmitModal use the same value —
 * two independent hexes for one meaning is how this codebase ends up with three
 * copies of everything.
 */
export const STAR_GOLD_CLASS = 'text-[#f0ad4e]';

const SIZE_CONFIG = {
  sm: {
    starText: 'text-[10px]',
    countText: 'text-[9px]',
    containerClass: 'text-[10px]',
  },
  lg: {
    starText: 'text-sm',
    countText: 'text-xs',
    containerClass: 'text-sm',
  },
};

export default function StarRating({ value, count, size, hideCount = false }: StarRatingProps) {
  // Render nothing when there are no reviews — caller owns the empty-state UX
  if (count < 1) return null;

  const cfg = SIZE_CONFIG[size];

  // Clamp value to [0, 5] so rogue data doesn't break the layout
  const clamped = Math.max(0, Math.min(5, value));
  // Fractional fill width as a percentage of the 5-star row
  const fillPercent = (clamped / 5) * 100;

  const STAR_CHAR = '\u2605'; // ★ filled
  const EMPTY_CHAR = '\u2606'; // ☆ empty

  return (
    <span
      role="img"
      aria-label={`${clamped.toFixed(1)} out of 5 stars, ${count} review${count === 1 ? '' : 's'}`}
      className={`inline-flex items-center gap-0.5 ${cfg.containerClass}`}
    >
      {/* Star row: filled overlay on top of empty base */}
      <span className="relative inline-block leading-none" aria-hidden="true">
        {/* Base layer — 5 empty stars (the "background") */}
        <span className={`${cfg.starText} text-fg-faint tracking-[0.5px]`}>
          {EMPTY_CHAR.repeat(5)}
        </span>
        {/* Filled layer — clipped to the fractional fill width */}
        <span
          className={`absolute inset-0 overflow-hidden ${cfg.starText} ${STAR_GOLD_CLASS} tracking-[0.5px]`}
          style={{ width: `${fillPercent}%` }}
        >
          {STAR_CHAR.repeat(5)}
        </span>
      </span>

      {/* Review count — subdued, after the stars. Hidden when hideCount is true (e.g. ReviewList rows). */}
      {!hideCount && (
        <span className={`${cfg.countText} text-fg-muted`}>
          ({count})
        </span>
      )}
    </span>
  );
}
