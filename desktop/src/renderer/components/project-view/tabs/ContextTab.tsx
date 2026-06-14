// ContextTab — the agent-context files for one project, grouped by scope
// (Task 4.1). Surfaces CLAUDE.md/AGENTS.md, rules, and memory notes in three
// teaching groups (This project / Global / Memory), each with a plain-language
// description and an (i) info button. Per-file rows show the label, the absolute
// path, and a PLAIN-TEXT "when it loads" badge.
//
// NO ●◐○ status glyphs anywhere — the glyph language is disliked; load timing is
// spelled out in words ("Always", "On recall", etc.). The (i) glyph and the
// plain-text pill are the only non-word affordances, both intentional.
import React, { useEffect, useState } from 'react';
import type {
  ContextGroup,
  ContextFile,
  ContextScope,
} from '../../../../shared/project-context-types';

interface ContextTabProps {
  project: { path: string }; // active CentralIndexProject; only .path is needed here
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

// Plain-text load-timing label. WHY: the "when does Claude load this file?"
// signal is the whole point of the badge — spelled out in words, never a glyph.
function timingLabel(f: ContextFile): string {
  switch (f.timing) {
    case 'always': return 'Always';
    case 'always-everywhere': return 'Always · everywhere';
    case 'conditional': return f.glob ? `When editing ${f.glob}` : 'Conditional';
    case 'on-recall': return 'On recall';
    case 'index': return 'Index';
  }
}

// Inline info-circle glyph (an "i", not a status glyph). Kept inline so the tab
// doesn't depend on a lucide import already in the project-view subtree.
function InfoIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

export function ContextTab({ project, onEditFile, onOpenInfo }: ContextTabProps) {
  const [groups, setGroups] = useState<ContextGroup[]>([]);
  const [loading, setLoading] = useState(true);

  // Load context groups on mount and whenever the project path changes. The
  // `cancelled` guard prevents a late response from a previous project from
  // overwriting the current project's list after a fast switch.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (window.claude as any).project.listContext(project.path)
      .then((res: any) => {
        if (cancelled) return;
        if (res && res.ok) setGroups(res.groups ?? []);
        else setGroups([]);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setGroups([]);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [project.path]);

  if (loading) {
    return (
      <div className="flex flex-col h-full overflow-hidden p-4 min-w-0">
        <p className="text-sm text-fg-muted">Loading…</p>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="flex flex-col h-full overflow-hidden p-4 min-w-0">
        <p className="text-sm text-fg-muted">No context files found for this project.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-auto p-4 min-w-0">
      {groups.map((group) => {
        const meta = GROUP_META[group.scope];
        return (
          <div key={group.scope} className="mb-5">
            {/* Group header: human label + description + (i) info button. */}
            <div className="flex items-center gap-2 mb-2 px-1">
              <span className="text-sm font-semibold text-fg">{meta.label}</span>
              <span className="text-[11.5px] text-fg-muted">{meta.desc}</span>
              <button
                type="button"
                className="ml-auto shrink-0 w-6 h-6 rounded-full inline-flex items-center justify-center text-fg-muted hover:text-fg hover:bg-inset transition-colors"
                title="Learn how these work"
                aria-label={`How ${meta.label} context works`}
                onClick={() => onOpenInfo(group.scope)}
              >
                <InfoIcon />
              </button>
            </div>

            {/* Files, or a muted "None found" line (header still shown so the
                teaching structure stays visible even for empty groups). */}
            {group.files.length === 0 ? (
              <p className="text-xs text-fg-muted px-1 py-1">None found</p>
            ) : (
              <div className="flex flex-col gap-2">
                {group.files.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className="layer-surface w-full text-left p-3 flex items-center gap-3 transition-colors hover:bg-inset"
                    onClick={() => onEditFile(f)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-fg truncate">{f.label}</span>
                      <span
                        className="block font-mono text-xs text-fg-muted truncate"
                        title={f.absolutePath}
                      >
                        {f.absolutePath}
                      </span>
                    </span>
                    {/* Plain-text load badge — subtle pill, never a glyph. */}
                    <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full bg-inset text-fg-muted border border-edge-dim">
                      {timingLabel(f)}
                    </span>
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
