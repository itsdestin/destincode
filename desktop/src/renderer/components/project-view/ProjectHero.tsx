// ProjectHero — the top card of the Project View main column (Task 2.2).
// Replaces the minimal inline hero placeholder from Task 2.1.
//
// Layout (matches docs/superpowers/prototypes/2026-06-14-project-view-redesign.html):
//   PROJECT eyebrow
//   <project name button ▾>                        [New Conversation]
//   [folder] path · [octocat] owner/name  (both inline click targets)
//   N files · N conversations · N context files · active <when>
// (2026-07-23: the separate "N artifacts" stat was dropped when the Artifacts
// tab merged into Files — there is no longer a tab for it to correspond to.)
//
// The project name is a clickable switcher trigger (opens <ProjectSwitcher>,
// Task 2.3) and MUST NOT truncate — it wraps. The ONE accent use in this card is
// the New Conversation primary button.
import React, { useEffect, useState } from 'react';
import type { CentralIndexProject } from '../../../shared/artifacts/types';
import { getPlatform } from '../../platform';
import { type SyncDot } from '../sync-dot-state';

// Live, computed-in-ProjectView stats (NOT the stale stats.artifactCount).
// 2026-07-23: the separate `artifacts` count was dropped when the Artifacts
// tab merged into Files — see the file-merge spec.
interface HeroStats {
  // All on-disk files (the Files tab). null = gated root (home dir /
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

import { createPortal } from 'react-dom';
import { FolderIcon, GitHubIcon, CogIcon } from './icons';
import { Button, TextInput } from '../ui';
import { useAnchoredMenu } from '../../hooks/useAnchoredMenu';
import { OverlayPanel } from '../overlays/Overlay';
import { useNarrowViewport } from '../../hooks/use-narrow-viewport';

const MENU_WIDTH = 240;

/** One row in the hero's cog menu. `danger` items render red at rest — these
 *  are consequential enough that hover is the wrong moment to find out
 *  (carried over from the old danger-outline buttons, spec decision 67). */
interface MenuItem {
  key: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
}

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

  // NARROW ONLY. Below 640px the management actions collapse behind a cog:
  // a row of six buttons plus a shrink-0 button column left the project name a
  // couple of characters wide on a phone. Desktop has the room, so it keeps
  // every action visible — collapsing there would cost a click for no gain.
  const narrow = useNarrowViewport();
  const menu = useAnchoredMenu<HTMLButtonElement>(MENU_WIDTH, 'right');

  const syncAction: MenuItem | null =
    sync?.dot.color === 'green' && sync.spaceId
      ? { key: 'sync-now', label: 'Sync now', onClick: () => onSyncNow(sync.spaceId!) }
    : sync?.dot.color === 'red' && sync.spaceId
      ? { key: 'sync-retry', label: 'Try syncing again', onClick: () => onSyncNow(sync.spaceId!) }
    : sync?.dot.color === 'gray' && !sync.spaceId
      ? { key: 'sync-on', label: 'Turn on sync for this project', onClick: onTurnOnSync }
    : null;

  const destructiveAction: MenuItem | null =
    canRemove
      ? { key: 'remove', label: 'Remove from YouCoded', onClick: onRemove, danger: true }
    : syncedFolderName && !sync?.stopped
      // Arms the inline confirm below the sync strip rather than acting
      // immediately — the consequence copy is too long for a menu row.
      ? { key: 'stop-sync', label: 'Stop syncing', onClick: () => setConfirmingStop(true), danger: true }
    : null;

  // 'reveal'/'repo' rows used to live here, duplicating "Open in File Explorer"/
  // "Open repo" — both are gone now that the path/repo line below is itself a
  // click target at every width, cog menu included.
  const menuItems: MenuItem[] = [
    { key: 'rename', label: 'Rename', onClick: () => setRenaming(true) },
    ...(syncAction ? [syncAction] : []),
    ...(destructiveAction ? [destructiveAction] : []),
  ];

  return (
    // Stacks below 640px. Before the cog collapse the right column was shrink-0
    // with two size="lg" buttons (~268px together), which on a 390px phone left
    // the entire left column — name, path, sync strip, stats — about 34px wide.
    <div className="layer-surface p-3 sm:p-5 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
      {/* Left: eyebrow + name switcher + path/repo + stat row */}
      <div className="min-w-0">
        <div className="text-[10px] font-medium tracking-wider text-fg-muted uppercase mb-1.5">
          Project
        </div>

        {/* Name as the switcher trigger. WHY: must NOT truncate — the user
            explicitly called this out. whitespace-normal + break-words let long
            project names wrap instead of clipping. */}
        {/* Renaming swaps the heading itself for the field. WHY here and not on
            an actions row (where it used to live): the rename target IS the
            name, so editing it anywhere else made you look in two places at
            once — and with the actions row gone there is nowhere else to put it. */}
        {renaming ? (
          <TextInput
            size="sm"
            value={nickname}
            autoFocus
            aria-label="Project nickname"
            className="text-2xl font-semibold w-full"
            onChange={(e) => setNickname(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(); if (e.key === 'Escape') { setNickname(shownName); setRenaming(false); } }}
            onBlur={() => void commitRename()}
          />
        ) : (
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
        )}

        {/* Path + optional owner/name repo slug — both double as click targets
            (Open in File Explorer / Open on GitHub), replacing the old
            standalone buttons this row now subsumes. */}
        <div className="flex items-center gap-2 mt-1.5 min-w-0">
          <button
            type="button"
            onClick={isElectron ? () => void (window.claude as any).shell.openPath(project.path) : undefined}
            disabled={!isElectron}
            className="inline-flex items-center gap-1 min-w-0 text-fg-muted hover:text-fg-2 transition-colors disabled:cursor-default"
            title={isElectron ? 'Open in File Explorer' : project.path}
          >
            <FolderIcon size={13} />
            <span
              className={`font-mono text-xs truncate ${isElectron ? 'underline decoration-dotted underline-offset-2 decoration-fg-faint hover:decoration-fg-muted' : ''}`}
            >
              {project.path}
            </span>
          </button>
          {showRepoSlug && (
            <>
              <span className="text-fg-faint shrink-0">·</span>
              <button
                type="button"
                onClick={() => window.claude.shell.openExternal(repo!.webUrl!)}
                className="inline-flex items-center gap-1 text-xs text-fg-dim hover:text-fg-2 shrink-0 transition-colors"
                title={`Open ${repo!.owner}/${repo!.name} on GitHub`}
              >
                <GitHubIcon size={13} />
                <span className="underline decoration-dotted underline-offset-2 decoration-fg-faint hover:decoration-fg-muted">
                  {repo!.owner}/{repo!.name}
                </span>
              </button>
            </>
          )}
        </div>

        {/* Sync status line (2026-07-09 spec §4). Plain words + the one action
            that matters for the state. Hidden when syncSpaces is unavailable. */}
        {sync && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-inset px-3 py-2">
            {/* On narrow the matching ACTION for each state moved into the cog
                menu, leaving this strip a one-line readout. Desktop keeps the
                button inline where it has always been. */}
            {sync.dot.color === 'green' && (
              <>
                <span className="text-[13px] font-semibold text-[#44A05C]">Syncs across your devices</span>
                {sync.lastSynced && <span className="text-xs text-fg-muted">Last synced {sync.lastSynced}</span>}
                {!narrow && sync.spaceId && (
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
                {!narrow && sync.spaceId && (
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
                {!narrow && (
                  <Button onClick={onTurnOnSync} className="py-1">
                    Turn on sync for this project
                  </Button>
                )}
              </>
            )}
          </div>
        )}

        {/* Stop-syncing confirm. Armed from the cog menu; the consequence copy
            is far too long for a menu row, so it lands here where the sync
            state it's about is already on screen. */}
        {confirmingStop && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-[#DD4444]/40 px-3 py-2">
            <span className="text-[11px] text-fg-dim max-w-[22rem]">
              Stop syncing “{shownName}”? The folder stays on all your devices, but changes will no longer sync between them. This can’t be undone from here.
            </span>
            <Button variant="danger-outline" size="sm" onClick={() => void commitStop()}>
              Stop syncing
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setConfirmingStop(false)}>
              Cancel
            </Button>
          </div>
        )}

        {/* Stat row — dot-separated. */}
        <div className="flex flex-wrap gap-4 mt-3 text-xs text-fg-muted">
          <span><b className="text-fg-2 font-semibold">{formatFileCount(stats.files, stats.filesTruncated)}</b> files</span>
          <span><b className="text-fg-2 font-semibold">{stats.conversations}</b> conversations</span>
          <span><b className="text-fg-2 font-semibold">{stats.contextFiles}</b> context files</span>
          <span>active <b className="text-fg-2 font-semibold">{stats.activeLabel}</b></span>
        </div>

        {/* Management actions (spec §4) — DESKTOP ONLY. Narrow reaches these
            through the cog menu instead; see the `narrow` note above.
            Rename = picker nickname only; the field itself renders up at the
            heading (one rename UI at both widths). Remove hides for synced
            projects (move-out-of-sync is a deferred flow). */}
        {!narrow && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!renaming && (
              <Button variant="secondary" size="sm" onClick={() => setRenaming(true)}>
                Rename
              </Button>
            )}
            {/* "Open in File Explorer" used to live here — it's now the path
                line above (every width, not desktop-only). */}
            {/* WHY danger-outline (spec decision 67): "Remove from YouCoded" and
                "Stop syncing" used to look neutral and only turn red on hover.
                These are consequential enough that hover is the wrong moment to
                find that out, so they read as destructive at rest. "Rename"
                above stays neutral — being the only non-red one is what makes
                it read as the safe action. */}
            {canRemove ? (
              <Button variant="danger-outline" size="sm" onClick={onRemove}>
                Remove from YouCoded
              </Button>
            ) : syncedFolderName && sync?.stopped ? (
              // Already stopped (permanent) — no action to offer, just the state
              // (review #4: don't re-render a "Stop syncing" button for a
              // project that's already a tombstone).
              <span className="text-[11px] text-fg-muted">Sync stopped</span>
            ) : syncedFolderName ? (
              !confirmingStop && (
                <Button variant="danger-outline" size="sm" onClick={() => setConfirmingStop(true)}>
                  Stop syncing
                </Button>
              )
            ) : (
              <span className="text-[11px] text-fg-muted">Managed by sync</span>
            )}
          </div>
        )}
      </div>

      {/* Right: cog menu + New Conversation. Everything else that used to sit
          here or on the actions row below is now behind the cog. */}
      <div className="w-full sm:w-auto sm:shrink-0 flex items-center gap-2">
        {/* "Open repo" used to live here — it's now the repo-slug link in the
            path/repo row above, reachable at every width. */}
        {/* The ONE accent use in this hero. */}
        <Button size="lg" className="flex-1 sm:flex-none" onClick={() => onNewConversation(project.path)}>
          New Conversation
        </Button>
        {narrow && (
          <button
            ref={menu.anchorRef}
            type="button"
            onClick={menu.toggle}
            className={`coarse-hit shrink-0 p-2 rounded-md border border-edge transition-colors ${
              menu.open ? 'bg-inset text-fg' : 'text-fg-muted hover:text-fg hover:bg-inset'
            }`}
            title="Project settings"
            aria-label="Project settings"
            aria-haspopup="menu"
            aria-expanded={menu.open}
          >
            <CogIcon size={16} />
          </button>
        )}
      </div>

      {narrow && menu.open && menu.pos && createPortal(
        <OverlayPanel
          ref={menu.menuRef}
          role="menu"
          // L4, not the old hardcoded z-[9000]. That value existed only to clear
          // ProjectView's z-[8000]; ProjectView is a z-40 screen now (change 26),
          // so 9000 would float this kebab above every overlay in the app. L4
          // matches the other portaled anchored menus (ContextMenu, Select).
          layer={4}
          className="overlay-no-drag fixed py-1"
          style={{ top: menu.pos.top, left: menu.pos.left, width: MENU_WIDTH, borderRadius: 'var(--radius-lg)' }}
        >
          {menuItems.map((item, i) => (
            <React.Fragment key={item.key}>
              {/* Hairline above the destructive item so it can't be hit by
                  muscle memory aimed at the row above it. */}
              {item.danger && i > 0 && <div className="my-1 border-t border-edge-dim" />}
              <button
                type="button"
                role="menuitem"
                onClick={menu.choose(item.onClick)}
                className={`coarse-roomy w-full text-left px-3 py-2 text-[13px] transition-colors hover:bg-inset ${
                  item.danger ? 'text-[#DD4444]' : 'text-fg-2 hover:text-fg'
                }`}
              >
                {item.label}
              </button>
            </React.Fragment>
          ))}
        </OverlayPanel>,
        document.body,
      )}
    </div>
  );
}
