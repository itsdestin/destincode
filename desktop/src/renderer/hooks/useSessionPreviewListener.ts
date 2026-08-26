import { useEffect } from 'react';
import { guardDirtyEditor } from '../components/artifact-views/dirty-editor-guard';
import type { ChatsearchProvider } from '../../shared/chatsearch-refs';

/**
 * Cards deep in the chat tree ask for a preview by event (the same
 * deep-component→destination pattern as youcoded:open-library). Lives in
 * ChatView, not the drawer, because the drawer is unmounted until it opens —
 * a listener inside the drawer would never hear the very first Preview click,
 * the one that is supposed to open the drawer.
 * guardDirtyEditor: opening a preview must never silently discard an unsaved
 * artifact edit.
 */
export function useSessionPreviewListener(sessionId: string, dispatch: (a: any) => void): void {
  useEffect(() => {
    const onPreview = (e: Event) => {
      const d = (e as CustomEvent).detail as { provider: ChatsearchProvider; id: string; title: string };
      if (!d?.id) return;
      guardDirtyEditor(() => {
        dispatch({ type: 'SESSION_REFERENCED', sessionId, ref: { ...d, lastActive: new Date().toISOString() } });
        dispatch({ type: 'SESSION_PREVIEW_SET', sessionId, provider: d.provider, id: d.id, title: d.title });
      });
    };
    window.addEventListener('youcoded:preview-session', onPreview);
    return () => window.removeEventListener('youcoded:preview-session', onPreview);
  }, [sessionId, dispatch]);
}
