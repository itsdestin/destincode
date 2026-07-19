// src/renderer/components/tags/SessionTagsChip.tsx
// The fixed in-session StatusBar element: colored tag dots + a notebook icon,
// or an "Add tags" button when the session has none. Opens a popup with the
// shared TagPicker + NoteEditor.
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import { useEscClose } from '../../hooks/use-esc-close';
import { useTagRegistry } from '../../hooks/useTagRegistry';
import { useSessionMeta } from '../../hooks/useSessionMeta';
import type { TagRecord } from '../../../shared/tags';
import { TagPicker } from './TagPicker';
import { NoteEditor } from './NoteEditor';

export function SessionTagsChip({ sessionId }: { sessionId: string | null }) {
  const [open, setOpen] = useState(false);
  const registry = useTagRegistry();
  const meta = useSessionMeta(sessionId);
  useEscClose(open, () => setOpen(false));

  const appliedTags = [...meta.tags]
    .map((id) => registry.byId.get(id))
    .filter((t): t is TagRecord => !!t);
  const hasContent = appliedTags.length > 0 || meta.note.length > 0;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        // Disabled for sessions the backend can't store meta for (native), so the
        // popup never accepts an edit that would be refused. See NATIVE_META_UNSUPPORTED.
        disabled={!sessionId || !meta.supported}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm border border-edge-dim enabled:hover:bg-inset transition-colors max-w-[220px] disabled:opacity-50 disabled:cursor-not-allowed"
        title={meta.supported ? 'Tags & note for this session' : meta.unsupportedReason}
      >
        {hasContent ? (
          <span className="flex items-center gap-1 overflow-hidden">
            {appliedTags.slice(0, 3).map((t) => (
              <span key={t.id} className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: `var(--${t.color})` }} />
            ))}
            {meta.note && <NotebookIcon className="w-3 h-3 text-fg-muted shrink-0" />}
            {appliedTags.length > 0 && (
              <span className="truncate text-fg-2">
                {appliedTags[0].label}{appliedTags.length > 1 ? ` +${appliedTags.length - 1}` : ''}
              </span>
            )}
          </span>
        ) : (
          <span className="text-fg-muted">Add tags</span>
        )}
      </button>
      {open && createPortal(
        <>
          <Scrim layer={2} onClick={() => setOpen(false)} />
          <div className="fixed inset-0 z-[61] flex items-center justify-center p-4 pointer-events-none">
            <OverlayPanel
              layer={2}
              className="w-full max-w-[360px] max-h-[80vh] flex flex-col pointer-events-auto"
              style={{ position: 'relative', zIndex: 'auto' }}
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
                <h2 className="text-sm font-bold text-fg">Tags &amp; note</h2>
                <button onClick={() => setOpen(false)}
                  className="text-fg-muted hover:text-fg-2 text-lg leading-none w-7 h-7 flex items-center justify-center rounded-sm hover:bg-inset">×</button>
              </div>
              <div className="px-4 py-3 space-y-3 overflow-y-auto">
                <TagPicker appliedIds={meta.tags} onToggle={meta.setTag} registry={registry} />
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-fg-muted mb-1 block">Note</label>
                  <NoteEditor value={meta.note} onSave={meta.setNote} />
                </div>
              </div>
            </OverlayPanel>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

function NotebookIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
    </svg>
  );
}
