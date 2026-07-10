// ProjectHero — the top card of the Project View main column (Task 2.2).
// Replaces the minimal inline hero placeholder from Task 2.1.
//
// Layout (matches docs/superpowers/prototypes/2026-06-14-project-view-redesign.html):
//   PROJECT eyebrow
//   <project name button ▾>          [Open repo ↗] [New Conversation]
//   path · owner/name
//   N artifacts · N files · N conversations · N context files · active <when>
//
// The project name is a clickable switcher trigger (opens <ProjectSwitcher>,
// Task 2.3) and MUST NOT truncate — it wraps. The ONE accent use in this card is
// the New Conversation primary button.
import React, { useEffect, useState } from 'react';
import type { CentralIndexProject } from '../../../shared/artifacts/types';
import { getPlatform } from '../../platform';
import { type SyncDot } from '../sync-dot-state';

// Live, computed-in-ProjectView stats (NOT the stale stats.artifactCount).
interface HeroStats {
  artifacts: number;  // Claude-authored (tracked)
  // All on-disk files (the All files section). null = gated root (home dir /
  // drive root — no scan runs, so there is no number to show).
  files: number | null;
  // True when discovery hit a cap — render "N+" so a truncated sample never
  // poses as an exact total.
  filesTruncated?: boolean;
  conversations: number;
  contextFiles: number;
  activeLabel: string;
}

// "N", "N+" (truncated), or "—" (gated — no scan ran). Shared by the hero
// stat line and ProjectView's segment badges so the two can't disagree.
export function formatFileCount(files: number | null, truncated?: boolean): string {
  if (files === null) return '—';
  return truncated ? `${files.toLocaleString()}+` : String(files);
}
// null when the project folder has no git remote.
interface HeroRepo {
  webUrl?: string;
  owner?: string;
  name?: string;
}

// Per-project sync props, derived in ProjectView from syncSpaces.status().
interface HeroSync {
  dot: SyncDot;
  spaceId: string | null;
  lastSynced: string | null;
  errorMessage: string | null;
}

interface ProjectHeroProps {
  project: CentralIndexProject;
  stats: HeroStats;
  repo: HeroRepo | null;
  onOpenSwitcher: () => void;
  onNewConversation: (cwd: string) => void;
  sync: HeroSync | null;             // null → syncSpaces unavailable: render no sync line
  onTurnOnSync: () => void;
  onSyncNow: (spaceId: string) => void;
  onRenamed: () => void;             // parent refreshes the list after a nickname rename
  canRemove: boolean;                // false for synced projects (move-out is deferred)
  onRemove: () => void;
}

// lucide-style chevron-down (matches prototype IC.chevDown).
function ChevronDown({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

// lucide-style external-link glyph (matches prototype IC.ext).
function ExternalLink({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
    </svg>
  );
}

// Git-branch glyph shared with ProjectSwitcher — lives in ./icons.tsx.
import { GitBranchIcon } from './icons';

export function ProjectHero({
  project,
  stats,
  repo,
  onOpenSwitcher,
  onNewConversation,
  sync,
  onTurnOnSync,
  onSyncNow,
  onRenamed,
  canRemove,
  onRemove,
}: ProjectHeroProps) {
  const showRepoSlug = !!(repo?.webUrl && repo.owner && repo.name);
  const isElectron = getPlatform() === 'electron';

  // Nickname rename — inline field on the actions row. Resets whenever the
  // active project changes (keyed on path) so a half-typed name from the last
  // project doesn't bleed into the next.
  const [renaming, setRenaming] = useState(false);
  const [nickname, setNickname] = useState(project.name);
  useEffect(() => { setNickname(project.name); setRenaming(false); }, [project.path]);
  const commitRename = async () => {
    const n = nickname.trim();
    setRenaming(false);
    if (!n || n === project.name) return;
    // Nickname only — NEVER the folder on disk. A folder rename would change the
    // sync identity (the repo name is derived from the folder), which the spec
    // defers. folders.rename updates the picker nickname, which
    // buildSavedFolderProjects prefers for the display name.
    await (window.claude as any).folders.rename(project.path, n).catch(() => {});
    onRenamed();
  };

  return (
    <div className="layer-surface p-5 flex items-start justify-between gap-4">
      {/* Left: eyebrow + name switcher + path/repo + stat row */}
      <div className="min-w-0">
        <div className="text-[10px] font-medium tracking-wider text-fg-muted uppercase mb-1.5">
          Project
        </div>

        {/* Name as the switcher trigger. WHY: must NOT truncate — the user
            explicitly called this out. whitespace-normal + break-words let long
            project names wrap instead of clipping. */}
        <button
          type="button"
          onClick={onOpenSwitcher}
          className="group flex items-start gap-2 text-left rounded-md -ml-1 px-1 py-0.5 hover:bg-inset transition-colors"
          title="Switch project"
        >
          <span className="text-2xl font-semibold text-fg leading-tight whitespace-normal break-words">
            {project.name}
          </span>
          <span className="text-fg-muted group-hover:text-fg shrink-0 mt-1.5">
            <ChevronDown size={18} />
          </span>
        </button>

        {/* Path + optional owner/name repo slug. */}
        <div className="flex items-center gap-2 mt-1.5 min-w-0">
          <span className="font-mono text-xs text-fg-muted truncate" title={project.path}>
            {project.path}
          </span>
          {showRepoSlug && (
            <>
              <span className="text-fg-faint shrink-0">·</span>
              <span className="inline-flex items-center gap-1 text-xs text-fg-dim shrink-0">
                <GitBranchIcon size={13} />
                {repo!.owner}/{repo!.name}
              </span>
            </>
          )}
        </div>

        {/* Sync status line (2026-07-09 spec §4). Plain words + the one action
            that matters for the state. Hidden when syncSpaces is unavailable. */}
        {sync && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-inset px-3 py-2">
            {sync.dot.color === 'green' && (
              <>
                <span className="text-[13px] font-semibold text-[#44A05C]">Syncs across your devices</span>
                {sync.lastSynced && <span className="text-xs text-fg-muted">Last synced {sync.lastSynced}</span>}
                {sync.spaceId && (
                  <button
                    type="button"
                    onClick={() => onSyncNow(sync.spaceId!)}
                    className="px-2.5 py-1 rounded-md bg-panel border border-edge-dim hover:border-edge text-xs text-fg-2 hover:text-fg transition-colors"
                  >
                    Sync now
                  </button>
                )}
              </>
            )}
            {sync.dot.color === 'red' && (
              <>
                <span className="text-[13px] font-semibold text-[#DD4444]">Sync isn't working</span>
                {sync.errorMessage && <span className="text-xs text-fg-dim">{sync.errorMessage}</span>}
                {sync.spaceId && (
                  <button
                    type="button"
                    onClick={() => onSyncNow(sync.spaceId!)}
                    className="px-2.5 py-1 rounded-md bg-panel border border-edge-dim hover:border-edge text-xs text-fg-2 hover:text-fg transition-colors"
                  >
                    Try again
                  </button>
                )}
              </>
            )}
            {sync.dot.color === 'gray' && sync.spaceId && (
              // Managed but global Sync is off — the honesty rule.
              <span className="text-[13px] text-fg-dim">Sync is turned off — this project will sync once you turn it on in Settings</span>
            )}
            {sync.dot.color === 'gray' && !sync.spaceId && (
              <>
                <span className="text-[13px] font-semibold text-fg-2">Only on this computer</span>
                <button
                  type="button"
                  onClick={onTurnOnSync}
                  className="px-3 py-1 rounded-md bg-accent text-on-accent text-xs hover:opacity-90 transition-opacity"
                >
                  Turn on sync for this project
                </button>
              </>
            )}
          </div>
        )}

        {/* Stat row — dot-separated. */}
        <div className="flex flex-wrap gap-4 mt-3 text-xs text-fg-muted">
          <span><b className="text-fg-2 font-semibold">{stats.artifacts}</b> artifacts</span>
          <span><b className="text-fg-2 font-semibold">{formatFileCount(stats.files, stats.filesTruncated)}</b> files</span>
          <span><b className="text-fg-2 font-semibold">{stats.conversations}</b> conversations</span>
          <span><b className="text-fg-2 font-semibold">{stats.contextFiles}</b> context files</span>
          <span>active <b className="text-fg-2 font-semibold">{stats.activeLabel}</b></span>
        </div>

        {/* Management actions (spec §4). Rename = picker nickname only. Remove
            hides for synced projects (move-out-of-sync is a deferred flow). */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {renaming ? (
            <input
              value={nickname}
              autoFocus
              onChange={(e) => setNickname(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(); if (e.key === 'Escape') { setNickname(project.name); setRenaming(false); } }}
              onBlur={() => void commitRename()}
              className="bg-inset text-fg text-xs rounded px-2 py-1 border border-edge-dim focus:border-accent outline-none"
            />
          ) : (
            <button type="button" onClick={() => setRenaming(true)} className="px-2.5 py-1 rounded-md border border-edge-dim hover:border-edge text-xs text-fg-2 hover:text-fg transition-colors">
              Rename
            </button>
          )}
          {isElectron && (
            <button
              type="button"
              onClick={() => void (window.claude as any).shell.openPath(project.path)}
              className="px-2.5 py-1 rounded-md border border-edge-dim hover:border-edge text-xs text-fg-2 hover:text-fg transition-colors"
            >
              Open in File Explorer
            </button>
          )}
          {canRemove ? (
            <button type="button" onClick={onRemove} className="px-2.5 py-1 rounded-md border border-edge-dim hover:border-edge text-xs text-fg-2 hover:text-[#DD4444] transition-colors">
              Remove from YouCoded
            </button>
          ) : (
            <span className="text-[11px] text-fg-faint">Managed by sync</span>
          )}
        </div>
      </div>

      {/* Right: Open repo (only when the project has a web URL) + New Conversation. */}
      <div className="shrink-0 flex items-center gap-2">
        {repo?.webUrl && (
          <button
            type="button"
            onClick={() => window.claude.shell.openExternal(repo.webUrl!)}
            className="px-3 py-2 rounded-md bg-inset text-fg-2 hover:text-fg border border-edge-dim hover:border-edge text-[13px] inline-flex items-center gap-1.5 transition-colors"
            title={showRepoSlug ? `Open ${repo.owner}/${repo.name} on GitHub` : 'Open repository'}
          >
            <ExternalLink size={14} />
            Open repo
          </button>
        )}
        {/* The ONE accent use in this hero. */}
        <button
          type="button"
          onClick={() => onNewConversation(project.path)}
          className="px-4 py-2 rounded-md bg-accent text-on-accent text-[13px] hover:opacity-90 transition-opacity"
        >
          New Conversation
        </button>
      </div>
    </div>
  );
}
