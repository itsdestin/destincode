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
import React from 'react';
import type { CentralIndexProject } from '../../../shared/artifacts/types';

// Live, computed-in-ProjectView stats (NOT the stale stats.artifactCount).
interface HeroStats {
  artifacts: number;  // Claude-authored (tracked)
  files: number;      // all on-disk documents (the All files section)
  conversations: number;
  contextFiles: number;
  activeLabel: string;
}
// null when the project folder has no git remote.
interface HeroRepo {
  webUrl?: string;
  owner?: string;
  name?: string;
}

interface ProjectHeroProps {
  project: CentralIndexProject;
  stats: HeroStats;
  repo: HeroRepo | null;
  onOpenSwitcher: () => void;
  onNewConversation: (cwd: string) => void;
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

// lucide-style git-branch glyph (matches prototype IC.git).
function GitGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
      <path d="M6 9v6" />
      <path d="M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
      <path d="M18 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

export function ProjectHero({
  project,
  stats,
  repo,
  onOpenSwitcher,
  onNewConversation,
}: ProjectHeroProps) {
  const showRepoSlug = !!(repo?.webUrl && repo.owner && repo.name);

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
                <GitGlyph size={13} />
                {repo!.owner}/{repo!.name}
              </span>
            </>
          )}
        </div>

        {/* Stat row — dot-separated. */}
        <div className="flex flex-wrap gap-4 mt-3 text-xs text-fg-muted">
          <span><b className="text-fg-2 font-semibold">{stats.artifacts}</b> artifacts</span>
          <span><b className="text-fg-2 font-semibold">{stats.files}</b> files</span>
          <span><b className="text-fg-2 font-semibold">{stats.conversations}</b> conversations</span>
          <span><b className="text-fg-2 font-semibold">{stats.contextFiles}</b> context files</span>
          <span>active <b className="text-fg-2 font-semibold">{stats.activeLabel}</b></span>
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
