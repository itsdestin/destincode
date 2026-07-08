// ContextTab — the agent-context files for one project, grouped by scope
// (Task 4.1). Surfaces CLAUDE.md/AGENTS.md, rules, and memory notes in three
// teaching groups (This project / Global / Memory), each with a plain-language
// description and an (i) info button. Rows match the prototype's ctxRow:
// icon avatar + basename + a plain-text load badge + a one-line description +
// size. Rows use `bg-panel border border-edge-dim rounded-lg` (NOT .layer-surface,
// whose overflow:hidden + flex compression clips text).
//
// NO ●◐○ status glyphs anywhere — load timing is spelled out in words.
//
// Data is fetched ONCE by ProjectView (shared with the hero count + cached per
// project) and passed in as `groups` — this tab no longer fetches on its own,
// which removed the duplicate context discovery that ran on every project switch.
import React from 'react';
import type {
  ContextGroup,
  ContextFile,
  ContextScope,
} from '../../../../shared/project-context-types';
import { ContextIntroBanner } from '../ContextIntroBanner';
// Plain-text load-timing label — shared with ContextEditorOverlay
// (context-labels.ts); spelled out in words, never a glyph.
import { timingLabel } from '../context-labels';

interface ContextTabProps {
  // Lifted, cached groups from ProjectView. null = still loading for this project.
  groups: ContextGroup[] | null;
  onEditFile: (file: ContextFile) => void;
  onOpenInfo: (scope: ContextScope) => void;
}

// Per-scope teaching copy. Descriptions are EXACT and intentionally have NO
// trailing periods (the wording was specified verbatim by the user).
const GROUP_META: Record<ContextScope, { label: string; desc: string }> = {
  project: { label: 'This project', desc: 'May be loaded for conversations in this project' },
  global: { label: 'Global', desc: 'Loaded before every conversation on this device' },
  memory: { label: 'Memory', desc: 'Recalled when relevant to a conversation' },
};

// Per-file row icon, by scope (matches the prototype: global→globe, memory→brain,
// project files→doc).
function FileGlyph({ scope, size = 17 }: { scope: ContextScope; size?: number }) {
  const common = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const, 'aria-hidden': true,
  };
  if (scope === 'global') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="10" /><path d="M2 12h20" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    );
  }
  if (scope === 'memory') {
    return (
      <svg {...common}>
        <path d="M12 5a3 3 0 1 0-5.997.142 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
        <path d="M12 5a3 3 0 1 1 5.997.142 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
    </svg>
  );
}

// Inline info-circle glyph (an "i", not a status glyph).
function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

export function ContextTab({ groups, onEditFile, onOpenInfo }: ContextTabProps) {
  if (groups === null) {
    return (
      <div className="flex flex-col h-full overflow-auto px-4 pt-1 pb-4 min-w-0">
        <ContextIntroBanner />
        <p className="text-sm text-fg-muted">Loading…</p>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="flex flex-col h-full overflow-auto px-4 pt-1 pb-4 min-w-0">
        <ContextIntroBanner />
        <p className="text-sm text-fg-muted">No context files found for this project.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-auto px-4 pt-1 pb-4 min-w-0">
      <ContextIntroBanner />
      {groups.map((group) => {
        const meta = GROUP_META[group.scope];
        return (
          <div key={group.scope} className="mb-5 shrink-0">
            {/* Group header: micro-label (.lbl style) + hint + (i) info button. */}
            <div className="flex items-center gap-2 mb-2 px-1">
              <span className="text-[10px] font-medium tracking-wider uppercase text-fg-muted">
                {meta.label}
              </span>
              <span className="text-[11.5px] text-fg-muted">{meta.desc}</span>
              <button
                type="button"
                className="ml-auto shrink-0 w-6 h-6 rounded-md inline-flex items-center justify-center text-fg-muted hover:text-fg hover:bg-inset transition-colors"
                title="Learn how these work"
                aria-label={`How ${meta.label} context works`}
                onClick={() => onOpenInfo(group.scope)}
              >
                <InfoIcon />
              </button>
            </div>

            {group.files.length === 0 ? (
              <p className="text-xs text-fg-muted px-1 py-1">None found</p>
            ) : (
              <div className="flex flex-col gap-2">
                {group.files.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className="w-full text-left flex items-center gap-3 bg-panel border border-edge-dim rounded-lg p-3 shrink-0 hover:bg-inset hover:border-edge transition-colors"
                    onClick={() => onEditFile(f)}
                    title={f.absolutePath}
                  >
                    <span className="w-9 h-9 rounded-md shrink-0 inline-flex items-center justify-center bg-inset text-fg-dim">
                      <FileGlyph scope={group.scope} size={17} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="text-[13.5px] font-medium font-mono text-fg truncate">{f.label}</span>
                        {/* Plain-text load badge — subtle pill, never a glyph. */}
                        <span className="inline-flex items-center text-[10px] text-fg-dim bg-well border border-edge-dim rounded-full px-2 py-0.5 shrink-0">
                          {timingLabel(f)}
                        </span>
                      </span>
                      {f.description ? (
                        <span className="block text-[12px] text-fg-2 truncate mt-0.5">{f.description}</span>
                      ) : null}
                    </span>
                    {f.size ? (
                      <span className="text-[11px] text-fg-faint font-mono shrink-0">{f.size}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
