import React, { useCallback, useEffect, useState } from 'react';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { useEscClose } from '../hooks/use-esc-close';
import { useTagRegistry } from '../hooks/useTagRegistry';
import { TagPicker } from './tags/TagPicker';
import { NoteEditor } from './tags/NoteEditor';
import { NATIVE_META_UNSUPPORTED, type SessionMetaResult } from '../../shared/types';

// Flag order must match ResumeBrowser's pill order so the UI is consistent.
type FlagName = 'priority' | 'complete';
const FLAG_ORDER: FlagName[] = ['priority', 'complete'];
const FLAG_LABEL: Record<FlagName, string> = { priority: 'Priority', complete: 'Complete' };

interface Props {
  open: boolean;
  sessionName?: string;
  sessionId?: string | null;
  onCancel: () => void;
  // onConfirm receives the reserved flags to set true, plus the TAG DELTA and the
  // note. The prompt preloads the session's current tags/note (so already-applied
  // tags stay selected) and reports only what the user changed off that baseline:
  // addTagIds/removeTagIds are the tags toggled on/off; noteChanged gates the write.
  onConfirm: (result: { flags: FlagName[]; addTagIds: string[]; removeTagIds: string[]; note: string; noteChanged: boolean }) => void;
}

// localStorage key used to suppress this prompt permanently. Exported so
// App.tsx can check it before deciding whether to show the prompt.
export const CLOSE_PROMPT_SUPPRESS_KEY = 'youcoded-close-prompt-disabled';
const SUPPRESS_KEY = CLOSE_PROMPT_SUPPRESS_KEY;

// Shown when the user closes an active session. Preloads the session's current
// tags + note (so applied tags stay selected — nothing changes unless the user
// toggles it), and lets them set Priority/Complete in the same step.
export default function CloseSessionPrompt({ open, sessionName, sessionId, onCancel, onConfirm }: Props) {
  const [sel, setSel] = useState<Record<FlagName, boolean>>({ priority: false, complete: false });
  // "Don't show again" — persisted to localStorage so the caller can skip this
  // prompt on future closes. Default off so users see it at least once.
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const registry = useTagRegistry();
  const [tagIds, setTagIds] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  // The session's tags/note as loaded on open — the baseline for the delta, so
  // Cancel changes nothing and Confirm only writes what the user toggled.
  const [original, setOriginal] = useState<{ tags: Set<string>; note: string }>({ tags: new Set(), note: '' });
  // False for sessions whose meta the backend refuses to store (native). This
  // prompt writes flags/tags/note and then IMMEDIATELY destroys the session, so
  // there is never a read-back to reveal a refused write — the only honest option
  // is to not offer the controls at all. See NATIVE_META_UNSUPPORTED.
  const [metaSupported, setMetaSupported] = useState(true);
  // Host-supplied wording — Android's reason differs from the desktop's.
  const [metaReason, setMetaReason] = useState(NATIVE_META_UNSUPPORTED);
  // Gate the meta section on the getMeta round-trip completing. Without this the
  // NoteEditor mounts optimistically, and text typed before the response arrives
  // is committed by its unmount-commit effect when the section then disappears —
  // producing a note write that gets refused. Cheap: the IPC is sub-frame.
  const [metaLoaded, setMetaLoaded] = useState(false);

  // On open, preload the session's current tags + note so already-applied tags
  // stay SELECTED. Reserved flags still default off — they're a "mark on close"
  // action, not existing state we read back.
  useEffect(() => {
    if (!open) return;
    setSel({ priority: false, complete: false });
    setDontShowAgain(false);
    setMetaSupported(true);
    setMetaLoaded(false);
    if (!sessionId) { setTagIds(new Set()); setNote(''); setOriginal({ tags: new Set(), note: '' }); setMetaLoaded(true); return; }
    let cancelled = false;
    Promise.resolve((window as any).claude.session.getMeta(sessionId))
      .then((m: SessionMetaResult) => {
        if (cancelled) return;
        const tags = new Set(m?.tags ?? []);
        setTagIds(new Set(tags));
        setNote(m?.note ?? '');
        setOriginal({ tags, note: m?.note ?? '' });
        // Missing field = older backend; assume supported rather than hiding the UI.
        setMetaSupported(m?.supported !== false);
        setMetaReason(m?.unsupportedReason || NATIVE_META_UNSUPPORTED);
        setMetaLoaded(true);
      })
      .catch(() => { if (!cancelled) { setTagIds(new Set()); setNote(''); setOriginal({ tags: new Set(), note: '' }); setMetaLoaded(true); } });
    return () => { cancelled = true; };
  }, [open, sessionId]);

  // Reserved flags to set + the tag delta (add/remove vs. the loaded baseline) +
  // the note. useCallback keeps a stable identity so the Enter effect below
  // doesn't re-subscribe its keydown listener every render.
  const buildResult = useCallback(() => ({
    flags: FLAG_ORDER.filter((f) => sel[f]),
    addTagIds: [...tagIds].filter((id) => !original.tags.has(id)),
    removeTagIds: [...original.tags].filter((id) => !tagIds.has(id)),
    note,
    noteChanged: note !== original.note,
  }), [sel, tagIds, note, original]);

  // ESC is routed through the central useEscClose stack so overlay LIFO and
  // chat-passthrough preventDefault work uniformly. Enter still needs its own
  // window listener because it submits rather than closes.
  useEscClose(open, onCancel);
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      // Don't hijack Enter while the user is typing in the tag search or the note.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      onConfirm(buildResult());
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, buildResult, onConfirm]);

  if (!open) return null;

  return (
    <>
      <Scrim layer={2} onClick={onCancel} />
      <div className="fixed inset-0 z-[61] flex items-center justify-center p-4 pointer-events-none">
        <OverlayPanel
          layer={2}
          className="w-full max-w-sm pointer-events-auto"
          style={{ position: 'relative', zIndex: 'auto' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-4 pt-4 pb-3 border-b border-edge">
            <h2 className="text-sm font-bold text-fg">Close session</h2>
            {sessionName && (
              <p className="text-[11px] text-fg-muted mt-1 truncate">{sessionName}</p>
            )}
          </div>
          <div className="px-4 py-4 flex flex-col gap-3">
            {!metaLoaded ? null : !metaSupported ? (
              <p className="text-[11px] text-fg-muted leading-snug">{metaReason}</p>
            ) : (
              <>
            <label className="text-[10px] uppercase tracking-wider text-fg-muted">Tag before closing</label>
            <div className="flex gap-1">
              {FLAG_ORDER.map((flag) => {
                const active = sel[flag];
                return (
                  <button
                    key={flag}
                    onClick={() => setSel((prev) => ({ ...prev, [flag]: !prev[flag] }))}
                    className={`flex-1 px-1 py-1.5 rounded-sm text-[11px] transition-colors ${
                      active
                        ? 'bg-accent text-on-accent font-medium'
                        : 'bg-inset text-fg-dim hover:bg-edge'
                    }`}
                    aria-pressed={active}
                  >
                    {FLAG_LABEL[flag]}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-fg-faint">
              {sel.complete
                ? 'Complete hides this from the resume menu by default.'
                : 'Tap a flag to tag this session, or close with none.'}
            </p>
            <div className="flex flex-col gap-1.5 mt-2">
              <label className="text-[10px] uppercase tracking-wider text-fg-muted">Tags</label>
              <TagPicker
                appliedIds={tagIds}
                onToggle={(id, next) => setTagIds((prev) => { const s = new Set(prev); if (next) s.add(id); else s.delete(id); return s; })}
                registry={registry}
              />
              <label className="text-[10px] uppercase tracking-wider text-fg-muted mt-1">Note</label>
              <NoteEditor value={note} onSave={setNote} />
            </div>
              </>
            )}
          </div>
          <div className="px-4 pb-4 flex items-center gap-2 justify-between">
            {/* Don't show again — persists suppress flag to localStorage so App.tsx
                skips this prompt on future closes and destroys sessions directly. */}
            <button
              onClick={() => setDontShowAgain((v) => !v)}
              className="flex items-center gap-1.5 text-[10px] text-fg-muted hover:text-fg transition-colors"
              aria-pressed={dontShowAgain}
            >
              <span
                className={`w-7 h-4 rounded-full transition-colors flex-shrink-0 ${
                  dontShowAgain ? 'bg-accent' : 'bg-edge'
                }`}
              >
                <span
                  className={`block w-3 h-3 rounded-full bg-on-accent shadow transition-transform mt-0.5 ${
                    dontShowAgain ? 'translate-x-3.5' : 'translate-x-0.5'
                  }`}
                />
              </span>
              Don't show again
            </button>
            <div className="flex gap-2">
              <button
                onClick={onCancel}
                className="text-[11px] text-fg-dim hover:text-fg px-3 py-1.5 rounded-md hover:bg-inset transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  // Persist suppress preference before confirming so the caller
                  // can immediately skip the prompt on the next close.
                  if (dontShowAgain) {
                    localStorage.setItem(SUPPRESS_KEY, '1');
                  }
                  onConfirm(buildResult());
                }}
                className="text-[11px] font-medium bg-accent text-on-accent px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity"
              >
                Close session
              </button>
            </div>
          </div>
        </OverlayPanel>
      </div>
    </>
  );
}
