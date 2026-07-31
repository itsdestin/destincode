// src/renderer/components/resume-card-icons.tsx
//
// Candidate drawings for the two icon buttons on a Resume Browser card, kept
// together so they can be compared at the same stroke weight and box size
// instead of drifting apart inline. Switchable from the workbench toolbar (see
// utils/design-variant.ts). When one of each is picked, delete the losers, drop
// the `variant` props, and fold the survivors back into ResumeBrowser.
//
// SHARED GEOMETRY, on purpose: every candidate is a 24×24 viewBox on a 1.8
// stroke, so switching between them changes the drawing and nothing else. The
// one exception is `dots-h`, which is filled rather than stroked — that IS the
// comparison (a filled glyph reads heavier beside a stroked eye at the same
// nominal size, which is the mismatch worth judging).
import React from 'react';

export const COMPLETE_ICONS = ['eye-slash', 'eye-simple', 'check-circle'] as const;
export type CompleteIconVariant = typeof COMPLETE_ICONS[number];

export const ORGANIZE_ICONS = ['dots-h', 'dots-v', 'tag'] as const;
export type OrganizeIconVariant = typeof ORGANIZE_ICONS[number];

const BOX = 'w-4 h-4';
const STROKE = {
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/** Complete. `done` is the applied state — every candidate has to read
 *  differently in both, not just look nice in one. */
export function CompleteIcon({ variant, done }: { variant: CompleteIconVariant; done: boolean }) {
  if (variant === 'check-circle') {
    // Concept alternative rather than a redraw: says "done", not "hidden".
    // Worth weighing because Complete's NAME is about finishing, even though
    // its EFFECT is to hide the row.
    return (
      <svg className={BOX} viewBox="0 0 24 24" {...STROKE} aria-hidden>
        <circle cx="12" cy="12" r="9" fill={done ? 'currentColor' : 'none'} />
        <path d="M8 12.5l2.5 2.5L16 9.5" stroke={done ? 'var(--canvas)' : 'currentColor'} />
      </svg>
    );
  }

  if (variant === 'eye-simple') {
    // Same eye in both states, with the slash as the ONLY difference. Reads
    // more like a toggle than eye-slash does, at the cost of a less literal
    // "hidden" picture — the eye stays wide open under the line.
    return (
      <svg className={BOX} viewBox="0 0 24 24" {...STROKE} aria-hidden>
        <path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z" />
        <circle cx="12" cy="12" r="2.5" />
        {done && <path d="M4 20L20 4" />}
      </svg>
    );
  }

  // eye-slash (current): the eye BREAKS around the slash when hidden, which is
  // the conventional drawing. More literal, but the two states share fewer
  // strokes so the flip is a bigger visual jump.
  return (
    <svg className={BOX} viewBox="0 0 24 24" {...STROKE} aria-hidden>
      {done ? (
        <>
          <path d="M9.9 4.24A9.1 9.1 0 0112 4c5 0 9 5 9 5a15.5 15.5 0 01-2.8 3.24M6.6 6.6A15.6 15.6 0 003 9s4 5 9 5a9 9 0 003.4-.66" />
          <path d="M9.9 9.9a3 3 0 004.2 4.2" />
          <path d="M3 3l18 18" />
        </>
      ) : (
        <>
          <path d="M3 9s4-5 9-5 9 5 9 5-4 5-9 5-9-5-9-5z" />
          <circle cx="12" cy="9" r="2.5" />
        </>
      )}
    </svg>
  );
}

/** Organize (tags + note). */
export function OrganizeIcon({ variant }: { variant: OrganizeIconVariant }) {
  if (variant === 'dots-v') {
    // Kebab. The conventional glyph for a per-ROW menu — horizontal dots more
    // often mean "more of this line's content" than "actions for this row".
    return (
      <svg className={BOX} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" />
      </svg>
    );
  }

  if (variant === 'tag') {
    // Names the contents instead of being a generic menu. Costs the "there are
    // more actions here" affordance a dot glyph carries for free, and the menu
    // also holds the note, which a tag shape doesn't suggest.
    return (
      <svg className={BOX} viewBox="0 0 24 24" {...STROKE} aria-hidden>
        <path d="M3 12.5V4.5A1.5 1.5 0 014.5 3h8l8.5 8.5a1.5 1.5 0 010 2.1l-6.9 6.9a1.5 1.5 0 01-2.1 0L3 12.5z" />
        <circle cx="7.75" cy="7.75" r="1.25" />
      </svg>
    );
  }

  // dots-h (current). Filled, so it sits heavier than the stroked eye beside it.
  return (
    <svg className={BOX} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}
