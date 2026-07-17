/**
 * The one field surface — shared by TextInput, Textarea, and the Select trigger.
 *
 * Replaces 3 focus paradigms x 3 backgrounds x 4 radii across ~25 inputs.
 * Retires: `focus:border-fg-muted` (gray focus), `focus:ring-*` focus,
 * `bg-canvas`/`bg-well` field surfaces, and `rounded`/`rounded-sm`/`rounded-md`
 * field radii.
 *
 * FIELD covers ALL text entry, not just type="text": password (the 6 API-key
 * sites), search, number (keeps type="number"), and <textarea>.
 * ProvidersSection's key input already WAS this baseline — it's the reference.
 *
 * Known and accepted: inputs on `bg-inset/50` cards now sit closer to their
 * background than before. The alternative (bg-well inside inset cards) was
 * offered during review and not taken.
 *
 * Spec: docs/active/specs/2026-07-16-ui-consistency-design-spec.md §1.3
 */

/** Focus is a border color change, never a ring — the ring belongs to buttons. */
export const FIELD =
  'bg-inset border border-edge-dim rounded-lg text-fg placeholder:text-fg-faint ' +
  'focus:outline-none focus:border-accent ' +
  // Disabled fields already exist (EngineCard's context-length input, InputBar's
  // composer, ReportReviewButton) and would otherwise lose their affordance.
  'disabled:opacity-50 disabled:cursor-not-allowed';

export type FieldSize = 'sm' | 'md';

export const FIELD_SIZE: Record<FieldSize, string> = {
  md: 'text-xs px-3 py-2',
  sm: 'text-2xs px-2.5 py-1.5',
};

export function fieldClasses(size: FieldSize = 'md', className = ''): string {
  return [FIELD, FIELD_SIZE[size], className].filter(Boolean).join(' ').trim();
}
