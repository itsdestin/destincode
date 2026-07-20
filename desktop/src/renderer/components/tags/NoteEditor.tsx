// src/renderer/components/tags/NoteEditor.tsx
import React, { useEffect, useRef, useState } from 'react';
import { Textarea } from '../ui';

export const NOTE_MAX = 8000;

// Freeform per-session note. maxLength hard-caps at 8000 chars (design); a
// remaining-count appears near the limit. Saves on blur (only when changed),
// and also on unmount so a note typed then ESC-closed (which fires no blur)
// isn't lost.
export function NoteEditor({ value, onSave, placeholder = 'Add a note…' }: {
  value: string;
  onSave: (text: string) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  // Refs so the unmount-commit reads the newest draft/value/onSave without
  // re-subscribing every render (onSave is often a fresh closure each render).
  const latest = useRef({ draft, value, onSave });
  latest.current = { draft, value, onSave };
  useEffect(() => () => {
    const { draft: d, value: v, onSave: save } = latest.current;
    if (d !== v) save(d);
  }, []);
  const remaining = NOTE_MAX - draft.length;
  const commit = () => { if (draft !== value) onSave(draft); };
  return (
    <div className="flex flex-col gap-1">
      {/* Change 42: onto the shared FIELD surface. `resizable` is passed on purpose —
          this note box genuinely IS drag-resizable today (it was `resize-y`), and
          the explicit resize-y className keeps it vertical-only; the primitive's
          `resizable` escape hatch otherwise falls back to the browser default of
          resizing in both axes, which would let it overflow its container. */}
      <Textarea
        size="sm"
        resizable
        className="w-full resize-y"
        aria-label={placeholder}
        value={draft}
        maxLength={NOTE_MAX}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        placeholder={placeholder}
        rows={3}
      />
      {remaining < 500 && (
        <span className="text-[9px] self-end text-fg-muted">{remaining} left</span>
      )}
    </div>
  );
}
