import { useState } from 'react';
import type { ToolCallState } from '../../../shared/types';

/**
 * The two things a person can do to a running helper — from its card, and
 * from the specialists popup (SpecialistsChip), same component both places. Both go
 * through the same host methods the assistant's own task_id calls use
 * (steerSpecialist / interruptSpecialist) — one mechanism, two callers.
 */
export function SpecialistActions({ sessionId, run }: { sessionId: string; run: NonNullable<ToolCallState['specialistRun']> }) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'note' | 'stop' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const first = run.title.split(' ')[0];
  const send = async () => {
    const text = note.trim();
    if (!text) return;
    setBusy('note'); setError(null);
    try {
      const res = await (window as any).claude?.specialists?.steer?.(sessionId, run.childId, text);
      if (res && res.ok === false) { setError(res.error || `Couldn’t deliver the note to ${first}.`); }
      else { setNote(''); setNoteOpen(false); }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const stop = async () => {
    setBusy('stop'); setError(null);
    try {
      const res = await (window as any).claude?.specialists?.interrupt?.(sessionId, run.childId);
      if (res && res.ok === false) setError(res.error || `Couldn’t stop ${first}.`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  return (
    <div className="space-y-1.5" data-testid="specialist-actions">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setNoteOpen(v => !v)}
          className="text-xs px-2 py-0.5 rounded-md border border-edge hover:bg-inset/60 transition-colors text-fg-2"
          aria-expanded={noteOpen}
        >
          Send {first} a note
        </button>
        <button
          type="button"
          onClick={stop}
          disabled={busy !== null}
          className="text-xs px-2 py-0.5 rounded-md border border-edge hover:bg-inset/60 transition-colors text-fg-2 disabled:opacity-50"
        >
          {busy === 'stop' ? 'Stopping…' : 'Stop'}
        </button>
      </div>
      {noteOpen && (
        <div className="flex items-start gap-2">
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
            rows={2}
            placeholder={`Anything ${first} should know mid-run — applied at its next step`}
            className="flex-1 min-w-0 text-xs rounded-md border border-edge bg-canvas px-2 py-1 text-fg resize-y"
          />
          <button
            type="button"
            onClick={send}
            disabled={busy !== null || !note.trim()}
            className="text-xs px-2 py-1 rounded-md bg-accent text-on-accent disabled:opacity-50"
          >
            {busy === 'note' ? 'Sending…' : 'Send'}
          </button>
        </div>
      )}
      {error && <div className="text-xs text-danger">{error}</div>}
    </div>
  );
}

