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
  // True when this project's registry record is a `stopped` tombstone (review
  // #4): a permanent detach, distinct from the global "Sync is turned off" state.
  stopped: boolean;
}

interface ProjectHeroProps {
  project: CentralIndexProject;
  // Synced display name from the cross-device project registry (2026-07-12),
  // overlaid at read time — prefer it over the folder name for a synced project.
  displayName?: string | null;
  stats: HeroStats;
  repo: HeroRepo | null;
  onOpenSwitcher: () => void;
  onNewConversation: (cwd: string) => void;
  sync: HeroSync | null;             // null → syncSpaces unavailable: render no sync line
  onTurnOnSync: () => void;
  onSyncNow: (spaceId: string) => void;
  onRenamed: () => void;             // parent refreshes the list after a rename / stop
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
import { Button, TextInput } from '../ui';

export function ProjectHero({
  project,
  displayName,
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

  // The visible name prefers the synced display name over the folder name.
  const shownName = displayName || project.name;
  // Folder name = the immutable sync identity, recovered from the space id. Non-
  // null only for a SYNCED project — that's what routes rename/stop through sync.
  const syncedFolderName = sync?.spaceId?.startsWith('project:')
    ? sync.spaceId.slice('project:'.length)
    : null;

  // Rename — inline field on the actions row. Resets whenever the active project
  // changes (keyed on path) so a half-typed name from the last project doesn't
  // bleed into the next. Seeded from the visible (possibly synced) name.
  const [renaming, setRenaming] = useState(false);
  const [nickname, setNickname] = useState(shownName);
  useEffect(() => { setNickname(shownName); setRenaming(false); }, [project.path, shownName]);
  const commitRename = async () => {
    const n = nickname.trim();
    setRenaming(false);
    if (!n || n === shownName) return;
    if (syncedFolderName) {
      // Synced project: change the SYNCED display name (propagates to every
      // device via the Personal space). NEVER the folder on disk — the repo name
      // is derived from the folder, so a folder move is a deferred flow (spec §15).
      await (window.claude as any).syncSpaces.renameProject?.(syncedFolderName, n).catch(() => {});
    } else {
      // Plain local folder: picker nickname only. folders.rename updates the
      // nickname, which buildSavedFolderProjects prefers for the display name.
      await (window.claude as any).folders.rename(project.path, n).catch(() => {});
    }
    onRenamed();
  };

  // Stop syncing — consequence-gated (destructive-UI convention): a first click
  // arms the confirm, a second confirms. Detaches this project's sync on every
  // device while keeping each local copy; permanent (no Resume — spec §15).
  const [confirmingStop, setConfirmingStop] = useState(false);
  useEffect(() => { setConfirmingStop(false); }, [project.path]);
  const commitStop = async () => {
    setConfirmingStop(false);
    if (!syncedFolderName) return;
    await (window.claude as any).syncSpaces.stopProject?.(syncedFolderName).catch(() => {});
    onRenamed(); // optimistic refresh; a Personal `synced` event also refreshes
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
            {shownName}
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
                  <Button variant="secondary" size="sm" onClick={() => onSyncNow(sync.spaceId!)}>
                    Sync now
                  </Button>
                )}
              </>
            )}
            {sync.dot.color === 'red' && (
              <>
                <span className="text-[13px] font-semibold text-[#DD4444]">Sync isn't working</span>
                {sync.errorMessage && <span className="text-xs text-fg-dim">{sync.errorMessage}</span>}
                {sync.spaceId && (
                  <Button variant="secondary" size="sm" onClick={() => onSyncNow(sync.spaceId!)}>
                    Try again
                  </Button>
                )}
              </>
            )}
            {sync.dot.color === 'gray' && sync.spaceId && sync.stopped && (
              // Stopped = permanent tombstone (detached on every device). Distinct
              // copy so it doesn't falsely promise it'll resume when sync is on.
              <span className="text-[13px] text-fg-dim">Sync stopped — this project stays on your devices but no longer syncs between them</span>
            )}
            {sync.dot.color === 'gray' && sync.spaceId && !sync.stopped && (
              // Managed but global Sync is off — the honesty rule.
              <span className="text-[13px] text-fg-dim">Sync is turned off — this project will sync once you turn it on in Settings</span>
            )}
            {sync.dot.color === 'gray' && !sync.spaceId && (
              <>
                <span className="text-[13px] font-semibold text-fg-2">Only on this computer</span>
                {/* py-1 keeps this button compact inside the sync status strip;
                    everything else (accent fill, radius, hover) comes from Button. */}
                <Button onClick={onTurnOnSync} className="py-1">
                  Turn on sync for this project
                </Button>
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
            /* Shared TextInput (change 20). Stays a plain field, not an
               InputGroup — this one commits on Enter/blur and has no submit
               button to put inside. */
            <TextInput
              size="sm"
              value={nickname}
              autoFocus
              aria-label="Project nickname"
              onChange={(e) => setNickname(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(); if (e.key === 'Escape') { setNickname(project.name); setRenaming(false); } }}
              onBlur={() => void commitRename()}
            />
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setRenaming(true)}>
              Rename
            </Button>
          )}
          {isElectron && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void (window.claude as any).shell.openPath(project.path)}
            >
              Open in File Explorer
            </Button>
          )}
          {/* WHY danger-outline (spec decision 67): "Remove from YouCoded" and
              "Stop syncing" used to look neutral and only turn red on hover.
              These are consequential enough that hover is the wrong moment to
              find that out, so they read as destructive at rest. "Rename" above
              stays neutral — being the only non-red one is what makes it read
              as the safe action. */}
          {canRemove ? (
            <Button variant="danger-outline" size="sm" onClick={onRemove}>
              Remove from YouCoded
            </Button>
          ) : syncedFolderName && sync?.stopped ? (
            // Already stopped (permanent) — no action to offer, just the state
            // (review #4: don't re-render a "Stop syncing" button for a project
            // that's already a tombstone).
            <span className="text-[11px] text-fg-faint">Sync stopped</span>
          ) : syncedFolderName ? (
            // Stop syncing (spec §10) — consequence-gated destructive action.
            confirmingStop ? (
              <span className="inline-flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-fg-dim max-w-[22rem]">
                  Stop syncing “{shownName}”? The folder stays on all your devices, but changes will no longer sync between them. This can’t be undone from here.
                </span>
                <Button variant="danger-outline" size="sm" onClick={() => void commitStop()}>
                  Stop syncing
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setConfirmingStop(false)}>
                  Cancel
                </Button>
              </span>
            ) : (
              <Button variant="danger-outline" size="sm" onClick={() => setConfirmingStop(true)}>
                Stop syncing
              </Button>
            )
          ) : (
            <span className="text-[11px] text-fg-faint">Managed by sync</span>
          )}
        </div>
      </div>

      {/* Right: Open repo (only when the project has a web URL) + New Conversation. */}
      <div className="shrink-0 flex items-center gap-2">
        {repo?.webUrl && (
          <Button
            variant="secondary"
            size="lg"
            onClick={() => window.claude.shell.openExternal(repo.webUrl!)}
            title={showRepoSlug ? `Open ${repo.owner}/${repo.name} on GitHub` : 'Open repository'}
          >
            <ExternalLink size={14} />
            Open repo
          </Button>
        )}
        {/* The ONE accent use in this hero. */}
        <Button size="lg" onClick={() => onNewConversation(project.path)}>
          New Conversation
        </Button>
      </div>
    </div>
  );
}
