// How wide a session pill actually is when it shows its name.
//
// WHY this is not just "text + chrome": a native-runtime session also carries a
// "YouCoded · Coder" badge inside the pill. The packer measured only the text
// and 28px of chrome, so for every native session it believed the pill was
// ~96px narrower than it is — and expanded pills the strip had no room for.
// The name then lost the fight for the leftover space and ellipsised while the
// badge sat beside it at full width, which is exactly what Destin reported on
// 2026-08-31. Measured that day: badge 96px, name clipped at 120 of 137px.
//
// Both the packer and the badge render from THIS file so they cannot drift.

/** Text of the runtime badge for a session, or null when it has none.
 *  `null` is the whole answer for a Claude Code session — no badge, no width. */
export function runtimeBadgeLabel(
  provider: string | undefined,
  harnessId: string | undefined,
): string | null {
  if (provider !== 'native') return null;
  return `YouCoded · ${harnessId === 'coder' ? 'Coder' : 'Assistant'}`;
}

/** Pill chrome around the label: 6px left pad + dot (10) + 4px gap + 6px right
 *  pad + 2px border. */
export const PILL_CHROME_PX = 28;

/** The badge's own box on top of its text: px-1 (8) + rounded chrome + the
 *  gap-1 (4) that separates it from the name. */
export const BADGE_CHROME_PX = 12;

/** Width the pill needs to show `name` in full, including the runtime badge
 *  when there is one. `measureText` is injected so this stays pure and the
 *  caller keeps owning the canvas. */
export function expandedPillWidth(
  name: string,
  badgeLabel: string | null,
  measureText: (text: string, font: string) => number,
): number {
  const nameW = measureText(name, '500 12px system-ui, -apple-system, sans-serif');
  // text-4xs — the badge renders a size smaller than the name.
  const badgeW = badgeLabel === null
    ? 0
    : measureText(badgeLabel, '400 9px system-ui, -apple-system, sans-serif') + BADGE_CHROME_PX;
  return Math.ceil(nameW + PILL_CHROME_PX + badgeW);
}
