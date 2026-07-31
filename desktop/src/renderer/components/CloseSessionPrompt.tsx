import React, { useCallback, useEffect, useState } from 'react';
import { useEscClose } from '../hooks/use-esc-close';
import { useTagRegistry } from '../hooks/useTagRegistry';
import { TagPicker } from './tags/TagPicker';
import { PRIORITY_TAG, PRIORITY_HINT } from './tags/built-in-tags';
import { TagManagerPopup } from './tags/TagManagerPopup';
import { NoteEditor } from './tags/NoteEditor';
import { Button, Dialog } from './ui';
import { META_UNSUPPORTED_FALLBACK, type SessionMetaResult } from '../../shared/types';
import { isTypingTarget } from '../utils/is-typing-target';

// The two reserved flags no longer share a control here (2026-07-31). Complete
// is the dialog's actual question, so it gets the one prominent check button;
// Priority is a tag and sits in the tag list. FLAG_ORDER survives only as the
// serialization order for buildResult's `flags` array — the labels it used to
// carry now live at each control.
type FlagName = 'priority' | 'complete';
const FLAG_ORDER: FlagName[] = ['priority', 'complete'];

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
  // Tag registry editing lives in its own surface now (it used to be a ✎ on
  // each TagPicker row). Layer 3 because this prompt is itself a layer-2 Dialog.
  const [manageOpen, setManageOpen] = useState(false);
  const [note, setNote] = useState('');
  // The session's tags/note as loaded on open — the baseline for the delta, so
  // Cancel changes nothing and Confirm only writes what the user toggled.
  const [original, setOriginal] = useState<{ tags: Set<string>; note: string }>({ tags: new Set(), note: '' });
  // False for sessions whose meta the backend refuses to store — as of Task 5
  // that's Android only (desktop native sessions are real store records now).
  // This prompt writes flags/tags/note and then IMMEDIATELY destroys the
  // session, so there is never a read-back to reveal a refused write — the
  // only honest option is to not offer the controls at all. See
  // META_UNSUPPORTED_FALLBACK.
  const [metaSupported, setMetaSupported] = useState(true);
  // Host-supplied wording — Android's reason differs from the desktop's.
  const [metaReason, setMetaReason] = useState(META_UNSUPPORTED_FALLBACK);
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
        setMetaReason(m?.unsupportedReason || META_UNSUPPORTED_FALLBACK);
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
      if (isTypingTarget(e.target as Element)) return;
      onConfirm(buildResult());
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, buildResult, onConfirm]);

  if (!open) return null;

  return (
    <>
      <Dialog open onClose={onCancel} size="prompt" aria-label="Close session" scrollBody={false}>
          <div className="px-4 pt-4 pb-3 border-b border-edge">
            <h2 className="text-sm font-bold text-fg">Close session</h2>
            {sessionName && (
              <p className="text-2xs text-fg-muted mt-1 truncate">{sessionName}</p>
            )}
          </div>
          <div className="px-4 py-4 flex flex-col gap-3">
            {!metaLoaded ? null : !metaSupported ? (
              <p className="text-2xs text-fg-muted leading-snug">{metaReason}</p>
            ) : (
              <>
              {/* "Are you done with this one?" is the QUESTION this dialog
                  exists to ask, so Complete is the one prominent control rather
                  than half of a two-button flag row. Same check-in-a-circle the
                  Resume Browser card uses, so the same act looks the same in
                  both places — set it here, and that is the state the card will
                  show. Priority is NOT beside it any more: it is a tag, and it
                  now lives in the tag list below like every other tag. */}
              <button
                type="button"
                onClick={() => setSel((prev) => ({ ...prev, complete: !prev.complete }))}
                aria-pressed={sel.complete}
                className={`flex items-center gap-2.5 w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
                  sel.complete ? 'border-accent bg-accent/10' : 'border-edge-dim bg-inset hover:border-edge'
                }`}
              >
                <svg className={`w-5 h-5 shrink-0 ${sel.complete ? 'text-accent' : 'text-fg-faint'}`}
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
                  strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="9" fill={sel.complete ? 'currentColor' : 'none'} />
                  <path d="M8 12.5l2.5 2.5L16 9.5" stroke={sel.complete ? 'var(--canvas)' : 'currentColor'} />
                </svg>
                <span className="min-w-0">
                  <span className="block text-xs text-fg">Mark complete</span>
                  <span className="block text-3xs text-fg-muted leading-snug">
                    Hides it from the resume list unless you turn on Show Complete.
                  </span>
                </span>
              </button>

              <div className="flex flex-col gap-1.5">
                <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Tags</label>
                {/* Priority as a built-in, exactly as in the Resume Browser's
                    tag sheet and the in-session chip. Unlike those two this one
                    is DEFERRED: the dialog collects a result and the caller
                    writes it on confirm (buildResult), so this toggles local
                    state instead of calling setFlag. Cancel must leave nothing
                    behind. */}
                <TagPicker
                  appliedIds={tagIds}
                  onToggle={(id, next) => setTagIds((prev) => { const s = new Set(prev); if (next) s.add(id); else s.delete(id); return s; })}
                  registry={registry}
                  onManageTags={() => setManageOpen(true)}
                  builtIns={[{
                    tag: PRIORITY_TAG,
                    hint: PRIORITY_HINT,
                    applied: sel.priority,
                    onToggle: (next) => setSel((prev) => ({ ...prev, priority: next })),
                  }]}
                />
                <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase mt-1">Note</label>
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
              className="flex items-center gap-1.5 text-3xs text-fg-muted hover:text-fg transition-colors"
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
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  // Persist suppress preference before confirming so the caller
                  // can immediately skip the prompt on the next close.
                  if (dontShowAgain) {
                    localStorage.setItem(SUPPRESS_KEY, '1');
                  }
                  onConfirm(buildResult());
                }}
              >
                Close session
              </Button>
            </div>
          </div>
      </Dialog>
      <TagManagerPopup open={manageOpen} onClose={() => setManageOpen(false)} registry={registry} layer={3} />
    </>
  );
}
