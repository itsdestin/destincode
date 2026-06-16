// ProjectSwitcher — command-palette project jumper (Task 2.3).
// Opened from the ProjectHero name button. A centered popup (L2) with a search
// field, a filtered "Recent" list of projects (avatar + name + repo glyph +
// mono path + files·chats hint + active check), and an "Add a project" footer.
//
// Layout/visuals mirror docs/superpowers/prototypes/2026-06-14-project-view-redesign.html
// (switcherPaletteEl). Icon style matches ProjectHero — inline lucide SVG,
// stroke currentColor.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import type { CentralIndexProject } from '../../../shared/artifacts/types';

interface ProjectSwitcherProps {
  projects: CentralIndexProject[];
  activeId: string | null;
  onSelect: (project: CentralIndexProject) => void;
  onClose: () => void;
  onAddProject: () => void;
  // Optional: removes a project from YouCoded (opens the confirm modal in the
  // parent). The palette is the project-list surface now that the rail is gone,
  // so the hover-revealed × delete lives on each row here.
  onDeleteProject?: (project: CentralIndexProject) => void;
}

// lucide-style search glyph (matches prototype IC.search).
function SearchGlyph({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

// lucide-style check glyph (the active-project indicator — NOT a status glyph).
function CheckGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

// lucide-style git-branch glyph (matches ProjectHero GitGlyph / prototype IC.git).
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

// lucide-style plus glyph (the "Add a project" footer).
function PlusGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

export function ProjectSwitcher({
  projects,
  activeId,
  onSelect,
  onClose,
  onAddProject,
  onDeleteProject,
}: ProjectSwitcherProps) {
  const [query, setQuery] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(0);
  // Inline feedback shown after "Add a project" — a project can only enter the
  // index once a session runs in its folder, so there's no folder-register flow
  // here (v1). We surface that as a brief inline hint instead of a toast/alert.
  const [hint, setHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the search field on open. WHY: autoFocus inside an overlay can race
  // the mount/scrim; the ref pattern is reliable. (See task notes.)
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Case-insensitive substring match against name OR path. Empty query → all
  // projects in their given order.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
    );
  }, [query, projects]);

  // Reset the keyboard highlight to the top whenever the filtered set changes
  // (query edits). Without this the highlight could point past the end.
  useEffect(() => {
    setHighlightIndex(0);
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filtered.length === 0) return;
      // Clamp to range (no wrap — stop at the last row).
      setHighlightIndex((i) => Math.min(i + 1, filtered.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filtered.length === 0) return;
      setHighlightIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const sel = filtered[highlightIndex];
      if (sel) onSelect(sel);
      return;
    }
  };

  const handleAdd = () => {
    // v1: a project only materializes in the index once a session runs in its
    // folder, so there's nothing to register here. Show a brief inline hint.
    setHint('Start a session in a folder to add it as a project.');
    onAddProject();
  };

  return (
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal={true}
        aria-label="Switch project"
        className="fixed left-1/2 top-[15%] -translate-x-1/2 w-[min(640px,92vw)] flex flex-col"
      >
        {/* Search row */}
        <div className="p-2.5 border-b border-edge-dim flex items-center gap-2">
          <span className="text-fg-muted pl-1">
            <SearchGlyph size={17} />
          </span>
          {/* Keydown lives on the input so ↑/↓/Enter/Esc work while it's focused
              (it autofocuses on open). OverlayPanel's typed props don't surface
              onKeyDown, so attaching here is the correct seam. */}
          <input
            ref={inputRef}
            type="text"
            placeholder="Jump to project…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent outline-none text-[15px] text-fg placeholder:text-fg-muted"
          />
          <span className="text-[10px] text-fg-faint border border-edge-dim rounded px-1.5 py-0.5">
            esc
          </span>
        </div>

        {/* Recent micro-label */}
        <div className="px-2 pt-2">
          <span className="px-2 text-[10px] tracking-wider text-fg-muted uppercase">
            Recent
          </span>
        </div>

        {/* Project rows */}
        <div className="p-2 max-h-[50vh] overflow-y-auto flex flex-col gap-0.5">
          {filtered.length === 0 && (
            <div className="px-3 py-4 text-[13px] text-fg-muted">
              No projects match “{query.trim()}”.
            </div>
          )}
          {filtered.map((p, i) => {
            const isActive = p.id === activeId;
            const isHighlighted = i === highlightIndex;
            const avatar = p.name.charAt(0).toUpperCase() || '?';
            return (
              // group/relative so the row can host a hover-revealed × delete
              // button (a button cannot nest inside the select button).
              <div key={p.id} className="group relative">
                <button
                  type="button"
                  // Keyboard highlight is outline-not-fill (border-accent); the
                  // active project gets a subtle bg-inset fill instead. pr-9
                  // reserves room for the hover × when delete is available.
                  className={`w-full flex items-center gap-2.5 px-2 py-2 ${onDeleteProject ? 'pr-9' : ''} rounded-md text-left transition-colors border ${
                    isHighlighted
                      ? 'border-accent bg-inset'
                      : isActive
                        ? 'border-transparent bg-inset'
                        : 'border-transparent hover:bg-inset'
                  }`}
                  onMouseEnter={() => setHighlightIndex(i)}
                  onClick={() => onSelect(p)}
                >
                  {/* Avatar: first letter of the name in a rounded square. */}
                  <span className="shrink-0 w-7 h-7 rounded-md bg-inset border border-edge-dim flex items-center justify-center text-[12px] font-semibold text-fg-2">
                    {avatar}
                  </span>
                  {/* Name + path. */}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-[13.5px] font-medium text-fg truncate">
                        {p.name}
                      </span>
                    </span>
                    <span className="block font-mono text-[11px] text-fg-muted truncate" title={p.path}>
                      {p.path}
                    </span>
                  </span>
                  {/* Files · chats hint. "files" = ALL FILES (fileCount) — the
                      folder's on-disk documents — falling back to the artifact
                      count until the withCounts pass resolves both. Chat count also
                      appears only after that pass (undefined on the fast first paint). */}
                  {(() => {
                    const files = p.fileCount ?? p.stats.artifactCount;
                    return (
                      <span className="text-[11px] text-fg-faint shrink-0 whitespace-nowrap">
                        {files} file{files === 1 ? '' : 's'}
                        {typeof p.conversationCount === 'number' && (
                          <> · {p.conversationCount} chat{p.conversationCount === 1 ? '' : 's'}</>
                        )}
                      </span>
                    );
                  })()}
                  {/* Active check (NOT a status glyph). */}
                  {isActive && (
                    <span className="text-fg shrink-0 ml-1">
                      <CheckGlyph size={15} />
                    </span>
                  )}
                </button>
                {/* Hover-revealed remove-from-YouCoded × (opens the confirm modal
                    in the parent). Does not delete files. */}
                {onDeleteProject && (
                  <button
                    type="button"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity w-6 h-6 rounded-md inline-flex items-center justify-center text-fg-muted hover:text-fg hover:bg-well"
                    title={`Remove ${p.name} from YouCoded`}
                    aria-label={`Remove ${p.name} from YouCoded`}
                    onClick={(e) => { e.stopPropagation(); onDeleteProject(p); }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Inline hint (after "Add a project") — replaces a toast/alert in v1. */}
        {hint && (
          <div className="px-4 py-2 text-[12px] text-fg-muted border-t border-edge-dim">
            {hint}
          </div>
        )}

        {/* Footer: Add a project. */}
        <button
          type="button"
          className="flex items-center gap-2 px-4 py-3 border-t border-edge-dim text-[13px] text-fg-2 hover:bg-inset hover:text-fg transition-colors rounded-b-[inherit]"
          onClick={handleAdd}
        >
          <PlusGlyph size={15} />
          Add a project
        </button>
      </OverlayPanel>
    </>
  );
}
