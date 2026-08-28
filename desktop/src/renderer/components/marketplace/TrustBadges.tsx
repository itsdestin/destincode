// The two trust signals a listing carries (design 2026-08-27, decision #2):
//   ScanBadge   — WAS IT CHECKED: Likely safe · Caution · Not checked
//   OriginBadge — WHO published it: YouCoded · Verified · Community
// Kept as two separate marks on purpose: merging them into one score hides
// the reason. Both are G-14 tag/badge shape — `sm` radius, icon + neutral
// text — never coloured text.
//
// Round 2 (Destin, 2026-08-28): the check mark is a grey SHIELD with a tick
// reading "Likely safe" (was a green dot reading "Checked"), and it comes
// first — safety is the question people are asking. The amber shield is the
// one documented hardcoded colour on this screen (STATUS_TONE vocabulary).
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
  checked: 'Likely safe',
  caution: 'Caution',
  unchecked: 'Not checked',
};

export function scanExplainer(scan: CatalogMeta['scan']): string {
  const n = scan.findings?.length ?? 0;
  if (scan.status === 'checked') {
    return `An automatic check read every file in this version${scan.checkedAt ? ` on ${new Date(scan.checkedAt).toLocaleDateString()}` : ''} and found nothing suspicious. "Likely" because no check is perfect — see "What this can do" for what it actually does.`;
  }
  if (scan.status === 'caution') {
    return `The automatic check found ${n} thing${n === 1 ? '' : 's'} worth reading before you install — they are listed under "What this can do".`;
  }
  return 'This version has not been checked yet. It may be fine; we just have not looked.';
}

const BADGE = 'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs text-fg-2 bg-inset border border-edge-dim whitespace-nowrap';

/** Shield glyph: tick (checked), exclamation (caution), or empty outline. */
export function ShieldIcon({ status, size = 12 }: { status: ScanStatus; size?: number }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...common} aria-hidden>
      <path d="M12 2l8 3v6c0 5-3.5 9.5-8 11-4.5-1.5-8-6-8-11V5z" />
      {status === 'checked' && <path d="M8.5 12l2.5 2.5 4.5-5" />}
      {status === 'caution' && <path d="M12 8v5M12 16.5v.5" />}
    </svg>
  );
}

const SHIELD_TONE: Record<ScanStatus, string> = {
  checked: 'text-fg-dim',
  caution: 'text-amber-400',
  unchecked: 'text-fg-muted',
};

export function ScanBadge({ scan, size = 'sm', responsiveLabel = false }: { scan: CatalogMeta['scan']; size?: 'sm' | 'md'; responsiveLabel?: boolean }) {
  const n = scan.findings?.length ?? 0;
  const label = scan.status === 'caution' && n > 0 ? `${SCAN_LABEL.caution} ${n}` : SCAN_LABEL[scan.status];
  return (
    <span className={size === 'md' ? `${BADGE} text-xs px-2` : BADGE} title={scanExplainer(scan)} aria-label={label} data-scan={scan.status}>
      <span className={`inline-flex ${SHIELD_TONE[scan.status]}`}><ShieldIcon status={scan.status} size={size === 'md' ? 14 : 12} /></span>
      {/* `responsiveLabel`: below the sm breakpoint show only the shield (the
          text wrapped the badge row onto two lines inside a phone-width card). */}
      <span className={responsiveLabel ? 'hidden sm:inline' : undefined}>{label}</span>
    </span>
  );
}

/** Round 2 (Destin): the author is a chip in the same row as the two trust
 *  badges, on every surface — not a line of grey text under the title. */
export function AuthorBadge({ author, size = 'sm' }: { author: string; size?: 'sm' | 'md' }) {
  return (
    // min-w-0 + overflow-hidden let the chip shrink and its name truncate
    // ("@des…") instead of the whole chip being clipped by the card edge.
    <span className={`${size === 'md' ? `${BADGE} text-xs px-2` : BADGE} max-w-[9rem] min-w-[3.75rem] overflow-hidden`} title={`Published by ${author}`} data-author>
      <span className="text-fg-dim inline-flex" aria-hidden>
        <svg width={size === 'md' ? 14 : 12} height={size === 'md' ? 14 : 12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </svg>
      </span>
      <span className="truncate min-w-0">{author}</span>
    </span>
  );
}

export function OriginBadge({ tier, size = 'sm' }: { tier: OriginTier; size?: 'sm' | 'md' }) {
  return (
    <span className={size === 'md' ? `${BADGE} text-xs px-2` : BADGE} title={ORIGIN_EXPLAINER[tier]} data-origin={tier}>
      <span className="text-fg-dim inline-flex" aria-hidden><OriginIcon tier={tier} size={size === 'md' ? 14 : 12} /></span>
      {ORIGIN_LABEL[tier]}
    </span>
  );
}
