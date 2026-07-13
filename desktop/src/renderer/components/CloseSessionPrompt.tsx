import React, { useEffect, useState } from 'react';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { useEscClose } from '../hooks/use-esc-close';
import { useTagRegistry } from '../hooks/useTagRegistry';
import { TagPicker } from './tags/TagPicker';
import { NoteEditor } from './tags/NoteEditor';

// Flag order must match ResumeBrowser's pill order so the UI is consistent.
type FlagName = 'priority' | 'complete';
const FLAG_ORDER: FlagName[] = ['priority', 'complete'];
const FLAG_LABEL: Record<FlagName, string> = { priority: 'Priority', complete: 'Complete' };

interface Props {
  open: boolean;
  sessionName?: string;
  onCancel: () => void;
  // onConfirm receives the reserved flags to set true, the tag ids to apply,
  // and the note text (empty = none). App fires the corresponding IPC calls.
  onConfirm: (result: { flags: FlagName[]; tagIds: string[]; note: string }) => void;
}

// localStorage key used to suppress this prompt permanently. Exported so
// App.tsx can check it before deciding whether to show the prompt.
export const CLOSE_PROMPT_SUPPRESS_KEY = 'youcoded-close-prompt-disabled';
const SUPPRESS_KEY = CLOSE_PROMPT_SUPPRESS_KEY;

// Shown when the user closes an active session. Lets them tag the session with
// any combination of Priority, Helpful, Complete in one step. Nothing is
// pre-selected — the user chooses which flags apply, or closes with none.
export default function CloseSessionPrompt({ open, sessionName, onCancel, onConfirm }: Props) {
  const [sel, setSel] = useState<Record<FlagName, boolean>>({ priority: false, complete: false });
  // "Don't show again" — persisted to localStorage so the caller can skip this
  // prompt on future closes. Default off so users see it at least once.
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const registry = useTagRegistry();
  const [tagIds, setTagIds] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open) {
      setSel({ priority: false, complete: false });
      setTagIds(new Set());
      setNote('');
      setDontShowAgain(false);
    }
  }, [open]);

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
      onConfirm({ flags: FLAG_ORDER.filter((f) => sel[f]), tagIds: [...tagIds], note });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, sel, tagIds, note, onConfirm]);

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
                  onConfirm({ flags: FLAG_ORDER.filter((f) => sel[f]), tagIds: [...tagIds], note });
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
