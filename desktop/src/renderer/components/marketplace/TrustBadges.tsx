// The two trust signals a listing carries (design 2026-08-27, decision #2):
//   OriginBadge — WHO published it: YouCoded · Verified · Community
//   ScanBadge   — WAS IT CHECKED: Checked · Caution · Not checked yet
// Kept as two separate marks on purpose: merging them into one score hides
// the reason. Both are G-14 tag/badge shape — `sm` radius, icon/dot + neutral
// text — never coloured text. The scan dot reuses the card's STATUS_TONE
// vocabulary (the one documented hardcoded-colour exception on this screen).
import React from 'react';
import type { CatalogMeta, OriginTier, ScanStatus } from '../../../shared/catalog-types';
import { OriginIcon } from './type-icons';

export const ORIGIN_LABEL: Record<OriginTier, string> = {
  youcoded: 'YouCoded',
  verified: 'Verified',
  community: 'Community',
};

export const ORIGIN_EXPLAINER: Record<OriginTier, string> = {
  youcoded: 'Made and maintained by the YouCoded team.',
  verified: 'The publisher proved they own this name (their GitHub account or website matches).',
  community: 'Published by someone we could not verify. Read what it can do before installing.',
};

export const SCAN_LABEL: Record<ScanStatus, string> = {
  checked: 'Checked',
  caution: 'Caution',
  unchecked: 'Not checked yet',
};

const BADGE = 'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs text-fg-2 bg-inset border border-edge-dim whitespace-nowrap';

export function OriginBadge({ tier, size = 'sm' }: { tier: OriginTier; size?: 'sm' | 'md' }) {
  return (
    <span className={size === 'md' ? `${BADGE} text-xs px-2` : BADGE} title={ORIGIN_EXPLAINER[tier]} data-origin={tier}>
      <span className="text-fg-dim inline-flex" aria-hidden><OriginIcon tier={tier} size={size === 'md' ? 14 : 12} /></span>
      {ORIGIN_LABEL[tier]}
    </span>
  );
}

// Dot colours: green = checked, amber = caution, dimmed = not checked. Grey
// on purpose for "not checked" — most mirrored items start there, and red
// everywhere would be noise, not signal.
const DOT: Record<ScanStatus, string> = {
  checked: 'bg-green-400',
  caution: 'bg-amber-400',
  unchecked: 'bg-fg-muted',
};

/** `responsiveLabel`: below the sm breakpoint show only the dot (the text
 *  wrapped the badge row onto two lines inside a phone-width card). */
export function ScanBadge({ scan, size = 'sm', responsiveLabel = false }: { scan: CatalogMeta['scan']; size?: 'sm' | 'md'; responsiveLabel?: boolean }) {
  const n = scan.findings?.length ?? 0;
  const label = scan.status === 'caution' && n > 0 ? `${SCAN_LABEL.caution} ${n}` : SCAN_LABEL[scan.status];
  const title = scan.status === 'checked'
    ? `Automatically checked${scan.checkedAt ? ` on ${new Date(scan.checkedAt).toLocaleDateString()}` : ''} — nothing suspicious found.`
    : scan.status === 'caution'
      ? `The automatic check found ${n} thing${n === 1 ? '' : 's'} to look at before installing.`
      : 'This version has not been checked yet.';
  return (
    <span className={size === 'md' ? `${BADGE} text-xs px-2` : BADGE} title={title} aria-label={label} data-scan={scan.status}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${DOT[scan.status]}`} aria-hidden />
      <span className={responsiveLabel ? 'hidden sm:inline' : undefined}>{label}</span>
    </span>
  );
}
