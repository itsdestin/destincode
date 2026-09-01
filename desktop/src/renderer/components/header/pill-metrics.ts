// How wide a session pill actually is when it shows its name.
//
// WHY this is not just "text + chrome": a native-runtime session also carries a
// "YouCoded · Coder" badge inside the pill. The packer once measured only the
// text and 28px of chrome, so for every native session it believed the pill was
// ~96px narrower than it is — and expanded pills the strip had no room for.
// The name then lost the fight for the leftover space and ellipsised while the
// badge sat beside it at full width, which is exactly what Destin reported on
// 2026-08-31. Measured that day: badge 96px, name clipped at 120 of 137px.
//
// The packer, the label's animated box (pill-label-style.ts) and the badge all
// take their numbers from THIS file so they cannot drift.
import { LABEL_TAIL_PX, LABEL_SLACK_PX } from './pill-label-style';

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

/** Fallback fonts for the two measurements, used only until the strip has
 *  read the REAL computed fonts off its own label (SessionStrip). WHY that
 *  matters: the app's UI font is a monospace (`--font-sans` is Cascadia Mono),
 *  and measuring a mono name with a proportional system font under-reports it
 *  by ~15% — which is why the packer expanded pills that did not fit, and why
 *  the first numeric-width label cut "fix chat scroll stick" to "fix chat
 *  scroll" (2026-09-01). */
export const NAME_FONT = '500 12px system-ui, -apple-system, sans-serif';
// text-4xs — the badge renders a size smaller than the name.
export const BADGE_FONT = '400 9px system-ui, -apple-system, sans-serif';

export interface PillFonts { name: string; badge: string }
export const FALLBACK_FONTS: PillFonts = { name: NAME_FONT, badge: BADGE_FONT };

export interface PillMetrics {
  /** The name's text width alone — what the label box animates open to (plus its tail). */
  nameWidth: number;
  /** The badge's full box (text + chrome), or 0 when the session has no badge. */
  badgeWidth: number;
  /** Everything: what the packer budgets for an expanded pill. */
  expandedWidth: number;
}

/** Measure one pill. `measureText` is injected so this stays pure and the
 *  caller keeps owning the canvas. */
export function pillMetrics(
  name: string,
  badgeLabel: string | null,
  measureText: (text: string, font: string) => number,
  fonts: PillFonts = FALLBACK_FONTS,
): PillMetrics {
  const nameWidth = measureText(name, fonts.name);
  const badgeWidth = badgeLabel === null ? 0 : measureText(badgeLabel, fonts.badge) + BADGE_CHROME_PX;
  // The label box opens to text + tail + slack (pill-label-style.ts); the packer
  // must reserve the same or a "fits exactly" name is squeezed by its own tail.
  const expandedWidth = Math.ceil(nameWidth) + LABEL_TAIL_PX + LABEL_SLACK_PX + PILL_CHROME_PX + Math.ceil(badgeWidth);
  return { nameWidth, badgeWidth, expandedWidth };
}

/** Width the pill needs to show `name` in full, including the runtime badge
 *  when there is one. Kept as the packer's one-number entry point. */
export function expandedPillWidth(
  name: string,
  badgeLabel: string | null,
  measureText: (text: string, font: string) => number,
  fonts: PillFonts = FALLBACK_FONTS,
): number {
  return pillMetrics(name, badgeLabel, measureText, fonts).expandedWidth;
}
