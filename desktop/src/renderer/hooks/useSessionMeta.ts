// src/renderer/hooks/useSessionMeta.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { NATIVE_META_UNSUPPORTED, type SessionMetaResult } from '../../shared/types';

export interface SessionMetaApi {
  tags: Set<string>;   // applied tag ids
  note: string;
  /** False when the backend will REFUSE writes for this session (a desktop native
   *  session, or an Android host where tags/notes aren't built yet). Render the
   *  controls disabled. */
  supported: boolean;
  /** Host-supplied explanation for `supported: false`, for the disabled tooltip.
   *  Falls back to NATIVE_META_UNSUPPORTED when the host didn't say. */
  unsupportedReason: string;
  setTag: (tagId: string, next: boolean) => void;
  setNote: (text: string) => void;
}

export function useSessionMeta(sessionId: string | null): SessionMetaApi {
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [note, setNoteState] = useState('');
  // Default TRUE so the controls don't flash disabled during the first getMeta.
  const [supported, setSupported] = useState(true);
  // Last value we believe the backend accepted — the rollback target for a
  // refused write. Kept in a ref so back-to-back setNote calls chain correctly.
  const savedNote = useRef('');
  const [unsupportedReason, setUnsupportedReason] = useState(NATIVE_META_UNSUPPORTED);

  // Only a refusal that explicitly says `unsupported` may flip `supported`.
  // Ordinary failures (invalid tag id, note too long) must NOT touch it — and
  // must not re-enable it either, which `setSupported(!res.unsupported)` did.
  const noteRefusal = useCallback((res: any) => {
    if (!res?.unsupported) return;
    setSupported(false);
    // Deliberately NOT res.error — that carries machine strings in places
    // (Android answers 'not-implemented-on-mobile'), and this text is shown to
    // the user. Only an explicit user-facing reason is displayed.
    if (res.unsupportedReason) setUnsupportedReason(String(res.unsupportedReason));
  }, []);

  const refetch = useCallback(() => {
    if (!sessionId) { setTags(new Set()); setNoteState(''); savedNote.current = ''; setSupported(true); return; }
    Promise.resolve((window as any).claude.session.getMeta(sessionId))
      .then((m: SessionMetaResult) => {
        setTags(new Set(m?.tags ?? []));
        setNoteState(m?.note ?? '');
        // Server truth resets the rollback target too, or a later refusal would
        // revert to a value the backend never held.
        savedNote.current = m?.note ?? '';
        // Older backends (remote peer on a previous build) omit the field entirely
        // — treat missing as supported so we never disable against an unknown host.
        setSupported(m?.supported !== false);
        setUnsupportedReason(m?.unsupportedReason || NATIVE_META_UNSUPPORTED);
      })
      .catch(() => { setTags(new Set()); setNoteState(''); savedNote.current = ''; setSupported(true); });
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
    const revert = () => setTags((prev) => {
      const s = new Set(prev); if (next) s.delete(tagId); else s.add(tagId); return s;
    });
    setTags((prev) => { const s = new Set(prev); if (next) s.add(tagId); else s.delete(tagId); return s; });
    // Optimistic, but NOT fire-and-forget: an ok:false (e.g. a native session, whose
    // meta the store can't hold yet) must roll the local state back, otherwise the
    // edit looks saved until the next refetch. Promise.resolve(...).catch still
    // swallows transport rejections (remote timeout / Android) — those are logged
    // backend-side and we leave the optimistic value rather than fighting the network.
    try {
      Promise.resolve((window as any).claude.session.setTag(sessionId, tagId, next))
        .then((res: any) => { if (res && res.ok === false) { revert(); noteRefusal(res); } })
        .catch(() => {});
    } catch { /* backend logs */ }
  }, [sessionId, noteRefusal]);

  const setNote = useCallback((text: string) => {
    if (!sessionId) return;
    // Revert target comes from a REF, not the render closure: two setNote calls
    // dispatched from the same callback instance would both capture the same
    // closure value, so a failed second write could roll back past the first.
    const prevNote = savedNote.current;
    savedNote.current = text;
    setNoteState(text);
    try {
      Promise.resolve((window as any).claude.session.setNote(sessionId, text))
        .then((res: any) => {
          if (res && res.ok === false) { savedNote.current = prevNote; setNoteState(prevNote); noteRefusal(res); }
        })
        .catch(() => {});
    } catch { /* backend logs */ }
  }, [sessionId, noteRefusal]);

  return { tags, note, supported, unsupportedReason, setTag, setNote };
}
