// src/renderer/hooks/useSessionMeta.ts
import { useCallback, useEffect, useState } from 'react';

export interface SessionMetaApi {
  tags: Set<string>;   // applied tag ids
  note: string;
  setTag: (tagId: string, next: boolean) => void;
  setNote: (text: string) => void;
}

export function useSessionMeta(sessionId: string | null): SessionMetaApi {
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [note, setNoteState] = useState('');

  const refetch = useCallback(() => {
    if (!sessionId) { setTags(new Set()); setNoteState(''); return; }
    Promise.resolve((window as any).claude.session.getMeta(sessionId))
      .then((m: { tags: string[]; note: string }) => {
        setTags(new Set(m?.tags ?? []));
        setNoteState(m?.note ?? '');
      })
      .catch(() => { setTags(new Set()); setNoteState(''); });
  }, [sessionId]);

  useEffect(() => {
    refetch();
    // Refetch on ANY session:meta-changed — deliberately NOT gated on the event's
    // session id. For a LIVE session the broadcast carries the RESOLVED Claude id
    // (ipc-handlers resolves via sessionIdMap before broadcasting) while this hook
    // holds the DESKTOP session id, so an id-equality gate would silently never
    // fire (e.g. the buddy window tagging the same live session). meta changes are
    // rare and getMeta is one cheap IPC call, so an unconditional refetch is both
    // correct and inexpensive. The user's own edits are already covered optimistically
    // by setTag/setNote below.
    const off = (window as any).claude.on?.sessionMetaChanged?.(() => refetch());
    return () => { if (typeof off === 'function') off(); };
  }, [sessionId, refetch]);

  const setTag = useCallback((tagId: string, next: boolean) => {
    if (!sessionId) return;
    setTags((prev) => { const s = new Set(prev); if (next) s.add(tagId); else s.delete(tagId); return s; });
    try { (window as any).claude.session.setTag(sessionId, tagId, next); } catch { /* backend logs */ }
  }, [sessionId]);

  const setNote = useCallback((text: string) => {
    if (!sessionId) return;
    setNoteState(text);
    try { (window as any).claude.session.setNote(sessionId, text); } catch { /* backend logs */ }
  }, [sessionId]);

  return { tags, note, setTag, setNote };
}
