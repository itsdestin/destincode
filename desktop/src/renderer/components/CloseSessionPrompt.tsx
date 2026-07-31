import React, { useCallback, useEffect, useState } from 'react';
import { useEscClose } from '../hooks/use-esc-close';
import { useTagRegistry } from '../hooks/useTagRegistry';
import { TagPicker } from './tags/TagPicker';
import { PRIORITY_TAG, PRIORITY_HINT } from './tags/built-in-tags';
import { TagChip } from './tags/TagChip';
import type { TagRecord } from '../../shared/tags';
import { TagManagerPopup } from './tags/TagManagerPopup';
import { NoteEditor } from './tags/NoteEditor';
import { Button, Dialog, Toggle } from './ui';
import { META_UNSUPPORTED_FALLBACK, type SessionMetaResult } from '../../shared/types';
import { isTypingTarget } from '../utils/is-typing-target';

// The two reserved flags no longer share a control here (2026-07-31). Complete
// is the dialog's actual question, so it gets the one prominent check button;
// Priority is a tag and sits in the tag list. FLAG_ORDER survives only as the
// serialization order for buildResult's `flags` array — the labels it used to
// carry now live at each control.
type FlagName = 'priority' | 'complete';
const FLAG_ORDER: FlagName[] = ['priority', 'complete'];

const COMPLETE_TITLE = 'Mark complete';
const COMPLETE_HINT = 'Hides it from the resume list unless you turn on Show Complete.';

/** The check-in-a-circle from the Resume Browser card, so the same act looks the
 *  same in both places. Filled when set; the check knocks out with var(--canvas)
 *  rather than a hardcoded white so it survives a dark or community theme. */
function CompleteGlyph({ done, className = '' }: { done: boolean; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" fill={done ? 'currentColor' : 'none'} />
      <path d="M8 12.5l2.5 2.5L16 9.5" stroke={done ? 'var(--canvas)' : 'currentColor'} />
    </svg>
  );
}

/** Chosen from four candidates in the workbench, 2026-07-31. A Toggle rather
 *  than a card or a checkbox: it is the shape Skip Permissions and Show
 *  Complete already use, so the app has one way of asking a yes/no. The row is
 *  not itself a button — the Toggle owns the interaction — but the container
 *  still lights on hover so it reads as one object. */
function MarkComplete({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-edge-dim bg-inset px-3 py-2.5 transition-colors hover:border-edge hover:bg-well">
      <CompleteGlyph done={checked} className={`w-5 h-5 shrink-0 transition-colors ${checked ? 'text-accent' : 'text-fg-faint'}`} />
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-fg">{COMPLETE_TITLE}</span>
        <span className="block text-3xs text-fg-muted leading-snug">{COMPLETE_HINT}</span>
      </span>
      <Toggle checked={checked} onChange={onChange} aria-label={COMPLETE_TITLE} />
    </div>
  );
}

interface Props {
  open: boolean;
  sessionName?: string;
  sessionId?: string | null;
  onCancel: () => void;
  // onConfirm receives a DELTA in every field. The prompt preloads the session's
  // current flags/tags/note (so what is already applied shows as applied) and
  // reports only what the user changed off that baseline: `flags` carries the
  // reserved flags whose value MOVED, addTagIds/removeTagIds the tags toggled
  // on/off, and noteChanged gates the note write.
  //
  // `flags` used to be a set-only FlagName[] — every listed flag was written
  // true and nothing could be cleared. That was fine while the two reserved
  // flags were a "mark on close" action that always started off. It stopped
  // being fine when Priority became a tag in this picker (2026-07-31): it now
  // preloads as applied, so un-toggling it has to be able to clear it, exactly
  // like un-toggling a real tag does.
  onConfirm: (result: {
    flags: Partial<Record<FlagName, boolean>>;
    addTagIds: string[]; removeTagIds: string[]; note: string; noteChanged: boolean;
  }) => void;
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
  // The tag/note EDITOR is collapsed by default (see the summary block below).
  // Not persisted and not remembered across opens: each close starts from the
  // summary, because the common case is closing a session without filing it.
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  // The session's tags/note as loaded on open — the baseline for the delta, so
  // Cancel changes nothing and Confirm only writes what the user toggled.
  const [original, setOriginal] = useState<{ tags: Set<string>; note: string; flags: Record<FlagName, boolean> }>(
    { tags: new Set(), note: '', flags: { priority: false, complete: false } },
  );
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

  // On open, preload the session's current flags + tags + note so whatever is
  // already applied SHOWS as applied.
  //
  // Reserved flags used to be excluded from this preload deliberately — they
  // were a "mark on close" action rather than state read back. That stopped
  // holding when Priority became an ordinary-looking tag in this picker: a
  // session already flagged Priority would have shown it unapplied, and
  // toggling it on then off would have done nothing. getMeta carries flags as
  // of 2026-07-31, so both are read and both round-trip through the delta.
  const EMPTY_FLAGS: Record<FlagName, boolean> = { priority: false, complete: false };
  useEffect(() => {
    if (!open) return;
    setSel({ ...EMPTY_FLAGS });
    setEditing(false);   // every close starts from the summary, not the editor
    setDontShowAgain(false);
    setMetaSupported(true);
    setMetaLoaded(false);
    const blank = { tags: new Set<string>(), note: '', flags: { ...EMPTY_FLAGS } };
    if (!sessionId) { setTagIds(new Set()); setNote(''); setOriginal(blank); setMetaLoaded(true); return; }
    let cancelled = false;
    Promise.resolve((window as any).claude.session.getMeta(sessionId))
      .then((m: SessionMetaResult) => {
        if (cancelled) return;
        const tags = new Set(m?.tags ?? []);
        // Missing `flags` = Android or an older remote peer. Absent reads as
        // "none set", never as an error.
        const flags: Record<FlagName, boolean> = {
          priority: !!m?.flags?.priority,
          complete: !!m?.flags?.complete,
        };
        setTagIds(new Set(tags));
        setNote(m?.note ?? '');
        setSel({ ...flags });
        setOriginal({ tags, note: m?.note ?? '', flags });
        // Missing field = older backend; assume supported rather than hiding the UI.
        setMetaSupported(m?.supported !== false);
        setMetaReason(m?.unsupportedReason || META_UNSUPPORTED_FALLBACK);
        setMetaLoaded(true);
      })
      .catch(() => { if (!cancelled) { setTagIds(new Set()); setNote(''); setOriginal(blank); setMetaLoaded(true); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId]);

  // Reserved flags to set + the tag delta (add/remove vs. the loaded baseline) +
  // the note. useCallback keeps a stable identity so the Enter effect below
  // doesn't re-subscribe its keydown listener every render.
  // What the collapsed summary shows. Priority rides `sel` rather than `tagIds`
  // because it is a reserved flag, so it has to be folded in here by hand.
  const appliedTags = [...tagIds]
    .map((id) => registry.byId.get(id))
    .filter((t): t is TagRecord => !!t);
  const hasMeta = sel.priority || appliedTags.length > 0 || note.trim().length > 0;

  const buildResult = useCallback(() => ({
    flags: Object.fromEntries(
      FLAG_ORDER.filter((f) => sel[f] !== original.flags[f]).map((f) => [f, sel[f]]),
    ) as Partial<Record<FlagName, boolean>>,
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
              {/* Tags and note lead, because closing a session is mostly a
                  filing action — but the FULL editor is a search field, a tag
                  list and a textarea, which is a lot of form for a dialog whose
                  primary button is "Close session". So the default state is a
                  SUMMARY of what is already applied, and the editor opens on
                  demand. An empty summary offers the same door with different
                  words, so "there is nothing here" and "you can add something"
                  are one control rather than two. */}
              {editing ? (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Tags</label>
                    <button
                      type="button"
                      onClick={() => setEditing(false)}
                      className="text-3xs text-fg-muted hover:text-fg transition-colors"
                    >
                      Done
                    </button>
                  </div>
                  {/* Priority as a built-in, exactly as in the Resume Browser's
                      tag sheet and the in-session chip. Unlike those two this
                      one is DEFERRED: the dialog collects a result and the
                      caller writes it on confirm (buildResult), so this toggles
                      local state instead of calling setFlag. Cancel must leave
                      nothing behind. */}
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
                  {/* Collapsing UNMOUNTS this, and NoteEditor commits its draft
                      on unmount as well as on blur — so "type a note, hit Done"
                      keeps the note rather than dropping it. */}
                  <NoteEditor value={note} onSave={setNote} />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="group w-full text-left rounded-lg border border-edge-dim bg-inset px-3 py-2.5 flex items-start gap-3 transition-colors hover:border-edge hover:bg-well"
                >
                  <span className="min-w-0 flex-1 flex flex-col gap-1.5">
                    {hasMeta ? (
                      <>
                        {(sel.priority || appliedTags.length > 0) && (
                          <span className="flex flex-wrap items-center gap-1">
                            {sel.priority && <TagChip tag={PRIORITY_TAG} />}
                            {appliedTags.map((t) => <TagChip key={t.id} tag={t} />)}
                          </span>
                        )}
                        {note.trim() && (
                          // One line only — the editor is a click away, and a
                          // long note would push the dialog's primary button
                          // off the bottom of the screen.
                          <span className="block text-2xs text-fg-2 truncate">{note.trim()}</span>
                        )}
                      </>
                    ) : (
                      <span className="block text-2xs text-fg-muted">No tags or note</span>
                    )}
                  </span>
                  <span className="text-3xs text-fg-muted group-hover:text-fg transition-colors shrink-0 mt-0.5">
                    {hasMeta ? 'Edit' : 'Add'}
                  </span>
                </button>
              )}

              {/* Mark complete sits LAST: the tags above are optional filing,
                  this is the actual "are you done with it?" question, and it
                  reads better immediately above the button that acts on it. */}
              <MarkComplete
                checked={sel.complete}
                onChange={(next) => setSel((prev) => ({ ...prev, complete: next }))}
              />
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
