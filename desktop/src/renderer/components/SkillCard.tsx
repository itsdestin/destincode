import React from 'react';
import type { SkillEntry } from '../../shared/types';
import { useMarketplaceStats } from '../state/marketplace-stats-context';
import StarRating from './marketplace/StarRating';
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
  variant?: 'drawer' | 'marketplace';
  installed?: boolean;
  updateAvailable?: boolean;
  onInstall?: (skill: SkillEntry) => void;
  installing?: boolean;
  /** When provided, a corner favorite star overlays the card. */
  favorite?: FavoriteProps;
  /** When provided, replaces the generic YC/Plugin/Prompt source tag with
   *  a clickable pill showing the parent plugin's marketplace displayName.
   *  Clicking routes the user to that plugin's detail page. Skills with
   *  no matching marketplace plugin fall back to the source tag. */
  pluginBadge?: PluginBadgeProps;
}

const sourceBadgeStyles: Record<string, string> = {
  'youcoded-core': 'bg-[#4CAF50]/15 text-[#4CAF50] border border-[#4CAF50]/25',
  self: 'bg-[#66AAFF]/15 text-[#66AAFF] border border-[#66AAFF]/25',
  plugin: 'bg-inset/50 text-fg-dim border border-edge/25',
  marketplace: 'bg-inset/50 text-fg-dim border border-edge/25',
};

const typeBadgeStyles: Record<string, string> = {
  prompt: 'bg-[#f0ad4e]/15 text-[#f0ad4e] border border-[#f0ad4e]/25',
  plugin: 'bg-inset/50 text-fg-dim border border-edge/25',
};

const typeLabels: Record<string, string> = {
  prompt: 'Prompt',
  plugin: 'Plugin',
};

// Clickable plugin-name pill. Shared between drawer + marketplace variants so
// the click-to-plugin-detail affordance looks identical everywhere. stops
// propagation so the card's own onClick doesn't also fire.
function PluginBadge({ name, onClick }: PluginBadgeProps) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={`Open ${name}`}
      className="text-[9px] font-medium px-1 py-0.5 rounded-sm shrink-0 bg-accent/10 text-accent border border-accent/30 hover:bg-accent/20 transition-colors truncate max-w-[120px]"
    >
      {name}
    </button>
  );
}

// Fallback tag used when a skill has no marketplace plugin parent (self-
// authored skills, youcoded-core bare skills).
function SourceTag({ skill }: { skill: SkillEntry }) {
  const cls = skill.source === 'youcoded-core'
    ? sourceBadgeStyles['youcoded-core']
    : (typeBadgeStyles[skill.type] ?? sourceBadgeStyles.plugin);
  const label = skill.source === 'youcoded-core'
    ? 'YC'
    : (typeLabels[skill.type] ?? 'Plugin');
  return (
    <span className={`text-[9px] font-medium px-1 py-0.5 rounded-sm shrink-0 ${cls}`}>
      {label}
    </span>
  );
}

export default function SkillCard({
  skill, onClick, variant = 'drawer', installed, updateAvailable,
  onInstall, installing, favorite, pluginBadge,
}: Props) {
  const { plugins } = useMarketplaceStats();
  const liveStats = plugins[skill.id];
  const liveInstalls = liveStats?.installs ?? skill.installs ?? null;
  const liveRating = liveStats?.rating ?? null;
  const liveReviewCount = liveStats?.review_count ?? 0;

  const badge = pluginBadge ? <PluginBadge {...pluginBadge} /> : <SourceTag skill={skill} />;

  if (variant === 'marketplace') {
    return (
      // Root is a div role=button so the nested FavoriteStar (itself a <button>)
      // is valid HTML. Matches the pattern MarketplaceCard uses.
      <div
        role="button"
        tabIndex={0}
        onClick={() => onClick(skill)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(skill); } }}
        className="relative bg-panel border border-edge-dim rounded-lg p-3 text-left hover:bg-inset hover:border-edge transition-colors flex flex-col cursor-pointer"
      >
        {favorite && (
          <FavoriteStar corner size="sm" filled={favorite.filled} onToggle={favorite.onToggle} />
        )}
        <div className="flex justify-between items-start gap-1">
          <span className="text-sm font-medium text-fg leading-tight">{skill.displayName}</span>
          {badge}
        </div>
        <span className="text-[11px] text-fg-muted mt-1 leading-snug line-clamp-2 flex-1">
          {skill.description}
        </span>
        {liveRating != null && (
          <div className="mt-1">
            <StarRating value={liveRating} count={liveReviewCount} size="sm" />
          </div>
        )}
        <div className="flex justify-between items-center mt-1">
          <span className="text-[9px] text-fg-faint">
            {skill.author ? `${skill.author}` : ''}
            {liveInstalls != null ? ` · ${liveInstalls >= 1000 ? `${(liveInstalls / 1000).toFixed(1)}k` : liveInstalls} ↓` : ''}
          </span>
        </div>
        {installed ? (
          <div className={`text-center text-[11px] py-1 mt-2 border rounded-sm ${
            updateAvailable
              ? 'text-[#f0ad4e] border-[#f0ad4e]/40'
              : skill.source === 'self' || skill.visibility === 'private'
                ? 'text-[#66AAFF] border-[#66AAFF]/40'
                : 'text-[#4CAF50] border-[#4CAF50]/40'
          }`}>
            {/* User-authored skills read "User Skill"; updates still win so */}
            {/* bumping versions isn't blocked by the user-skill label. */}
            {updateAvailable
              ? 'Update Available'
              : skill.source === 'self' || skill.visibility === 'private'
                ? 'User Skill'
                : 'Installed'}
          </div>
        ) : installing ? (
          <div className="text-center text-[11px] py-1 mt-2 border rounded-sm text-fg-muted border-edge-dim opacity-60">
            Installing...
          </div>
        ) : onInstall ? (
          <button
            onClick={(e) => { e.stopPropagation(); onInstall(skill); }}
            className="w-full bg-accent text-on-accent text-[11px] font-medium py-1 mt-2 rounded-sm hover:brightness-110 transition-colors"
          >
            Get
          </button>
        ) : null}
      </div>
    );
  }

  // Drawer variant — root is a <div role="button"> with `relative` so the
  // FavoriteStar can sit inside without an outer wrapper distorting the
  // drawer grid's flex sizing. Content is uniform (displayName + description
  // + badge), so no fixed height is needed — every tile is naturally the
  // same shape.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onClick(skill)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(skill); } }}
      className="relative bg-panel border border-edge-dim rounded-lg p-3 text-left hover:bg-inset hover:border-edge transition-colors flex flex-col cursor-pointer"
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
