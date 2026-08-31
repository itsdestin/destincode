import type { ReactNode } from 'react';

/**
 * A small, STATIC label — a count, a record, a tag. Not a control: it has no
 * click target, no focus ring and no hover state, because nothing happens when
 * you press it.
 *
 * WHY THIS EXISTS. The design guide names "chips, tags, key caps, inline
 * badges" as one category with one radius (G-3, `sm` = 4px), but the tree had
 * no shared piece for it — three places had each hand-rolled their own, and a
 * fourth was about to. G-1 is "one primitive, one look"; this is that one look.
 *
 * NOT `rounded-full`. The guide reserves the fully-round shape for the
 * send/stop circle, avatars, toggles and the pill-shaped FILTER chips — all
 * things you click. A round static label would read as a button that does
 * nothing.
 *
 * NEUTRAL BY DEFAULT, and there is no coloured variant on purpose: the guide's
 * tag rule (a dot plus neutral text, never coloured text) exists because
 * coloured small text failed contrast on the light themes.
 */
export interface BadgeProps {
  children: ReactNode;
  /** Announced instead of the visible text when the short form is ambiguous
   *  out of context — "4 wins, 2 losses" for a badge reading "4W - 2L". */
  label?: string;
  className?: string;
}

export function Badge({ children, label, className = '' }: BadgeProps) {
  return (
    <span
      // `tabular-nums` so a column of these does not jitter as the digits
      // change width — a record badge sits in a list, one per row.
      className={`inline-flex items-center shrink-0 rounded-sm border border-edge-dim bg-inset
        px-1.5 py-0.5 text-3xs leading-none text-fg-2 tabular-nums ${className}`}
      {...(label ? { 'aria-label': label, role: 'img' } : {})}
    >
      {children}
    </span>
  );
}
