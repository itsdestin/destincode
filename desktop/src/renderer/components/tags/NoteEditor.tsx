// src/renderer/components/tags/NoteEditor.tsx
import React, { useEffect, useState } from 'react';

export const NOTE_MAX = 8000;

// Freeform per-session note. maxLength hard-caps at 8000 chars (design); a
// remaining-count appears near the limit. Saves on blur (only when changed).
export function NoteEditor({ value, onSave, placeholder = 'Add a note…' }: {
  value: string;
  onSave: (text: string) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const remaining = NOTE_MAX - draft.length;
  const commit = () => { if (draft !== value) onSave(draft); };
  return (
    <div className="flex flex-col gap-1">
      <textarea
        value={draft}
        maxLength={NOTE_MAX}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        placeholder={placeholder}
        rows={3}
        className="w-full resize-y rounded-sm bg-inset text-fg text-[11px] px-2 py-1.5 border border-edge-dim focus:border-accent outline-none"
      />
      {remaining < 500 && (
        <span className="text-[9px] self-end text-fg-faint">{remaining} left</span>
      )}
    </div>
  );
}
