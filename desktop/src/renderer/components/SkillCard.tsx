import React from 'react';
import type { SkillEntry } from '../../shared/types';
import FavoriteStar from './marketplace/FavoriteStar';

interface FavoriteProps {
  filled: boolean;
  onToggle: () => void;
}

interface PluginBadgeProps {
  name: string;
  onClick: () => void;
}

interface Props {
  skill: SkillEntry;
  onClick: (skill: SkillEntry) => void;
  /** When provided, a corner favorite star overlays the card. */
  favorite?: FavoriteProps;
  /** When provided, replaces the generic YC/Plugin/Prompt source tag with
   *  a clickable pill showing the parent plugin's marketplace displayName.
   *  Clicking routes the user to that plugin's detail page. Skills with
   *  no matching marketplace plugin fall back to the source tag. */
  pluginBadge?: PluginBadgeProps;
}

// Change 23: every badge this card renders is an IDENTITY badge — "YC",
// "Prompt", "Plugin", or a plugin's display name. None of them is a status, so
// none of them earns a status color. They all collapse to the one accent pill
// the design review approved (the blue-status alternative was offered and not
// taken). This retires the last raw #4CAF50 / #f0ad4e hexes in this file; the
// only reason they differed before was that the map grew one key at a time.
const IDENTITY_BADGE =
  'bg-accent/15 text-accent border border-accent/30';

const typeLabels: Record<string, string> = {
  prompt: 'Prompt',
  plugin: 'Plugin',
};

// Clickable plugin-name pill. Shared between the source tag and this pill so
// the click-to-plugin-detail affordance looks identical everywhere. stops
// propagation so the card's own onClick doesn't also fire.
function PluginBadge({ name, onClick }: PluginBadgeProps) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={`Open ${name}`}
      className={`text-[9px] font-medium px-1 py-0.5 rounded-sm shrink-0 ${IDENTITY_BADGE} hover:bg-accent/25 transition-colors truncate max-w-[120px]`}
    >
      {name}
    </button>
  );
}

// Fallback tag used when a skill has no marketplace plugin parent (self-
// authored skills, youcoded-core bare skills).
function SourceTag({ skill }: { skill: SkillEntry }) {
  const label = skill.source === 'youcoded-core'
    ? 'YC'
    : (typeLabels[skill.type] ?? 'Plugin');
  return (
    <span className={`text-[9px] font-medium px-1 py-0.5 rounded-sm shrink-0 ${IDENTITY_BADGE}`}>
      {label}
    </span>
  );
}

// Custom memo comparator. Without this, every parent re-render rebuilds the
// inline `favorite` and `pluginBadge` objects (CommandDrawer.renderSkillCard
// creates them fresh each render — see CommandDrawer.tsx:165-174), so default
// shallow-equal would always fail and every card would re-render on every
// chat-store dispatch. Compare the values that actually drive what the user
// sees (filled, name) and ignore the closure-identity of onToggle/onClick —
// React only cares which function fires on click, and the latest one fires
// either way thanks to React's render-phase capture. Fixes the v1.2.2 drawer
// flicker (chat dispatches → AppInner re-render → 20 cards re-render → paint
// glitch on Windows Electron).
function skillCardPropsEqual(prev: Props, next: Props): boolean {
  if (prev.skill !== next.skill) return false;
  if (prev.onClick !== next.onClick) return false;
  const pf = prev.favorite, nf = next.favorite;
  if ((pf == null) !== (nf == null)) return false;
  if (pf && nf && pf.filled !== nf.filled) return false;
  const pb = prev.pluginBadge, nb = next.pluginBadge;
  if ((pb == null) !== (nb == null)) return false;
  if (pb && nb && pb.name !== nb.name) return false;
  return true;
}

// Root is a <div role="button"> with `relative` so the FavoriteStar (itself a
// <button>) can sit inside without an outer wrapper distorting the drawer
// grid's flex sizing, and without nesting a button in a button. Content is
// uniform (displayName + description + badge), so no fixed height is needed —
// every tile is naturally the same shape.
//
// This card had a second `variant="marketplace"` branch until 2026-07-22. It
// was unreachable: CommandDrawer is the only importer and never passed the
// prop, and LibraryScreen's similarly-named renderSkillCard actually renders a
// MarketplaceCard. Deleted rather than migrated — MarketplaceCard owns the
// marketplace card. See spec §14.2.
function SkillCardImpl({ skill, onClick, favorite, pluginBadge }: Props) {
  const badge = pluginBadge ? <PluginBadge {...pluginBadge} /> : <SourceTag skill={skill} />;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onClick(skill)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(skill); } }}
      // Change 22: .layer-surface replaces `bg-panel border border-edge-dim`.
      // The two overrides are load-bearing, not stylistic — .layer-surface is
      // --radius-xl with a `0 8px 32px` shadow, and this grid is flat by
      // decision (mixed elevation in one grid read as inconsistent, user
      // feedback 2026-07-08). Same pair FilesTab's doc cards use.
      className="relative layer-surface !rounded-lg card-interactive p-3 text-left flex flex-col cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      style={{ boxShadow: 'none' }}
    >
      {favorite && (
        <FavoriteStar corner size="sm" filled={favorite.filled} onToggle={favorite.onToggle} />
      )}
      <span className="text-sm font-medium text-fg leading-tight">{skill.displayName}</span>
      <span className="text-[11px] text-fg-muted mt-1 leading-snug line-clamp-2 flex-1">{skill.description}</span>
      <div className="mt-2 self-start">{badge}</div>
    </div>
  );
}

const SkillCard = React.memo(SkillCardImpl, skillCardPropsEqual);
export default SkillCard;
