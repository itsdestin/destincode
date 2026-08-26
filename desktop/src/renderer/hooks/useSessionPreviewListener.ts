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
 *
 * WHY the `visible` gate: App.tsx mounts one ChatView PER OPEN SESSION TAB and
 * keeps background tabs mounted (sessions.map in App.tsx), so this hook runs
 * once per open tab. The `youcoded:preview-session` event is a plain window
 * event with no session id in it — every listener that's live hears every
 * click. Without the gate, clicking Preview in one tab dispatched
 * SESSION_REFERENCED/SESSION_PREVIEW_SET in EVERY open tab at once, force-
 * opening each one's drawer and nulling out whatever artifact it had open.
 * `visible` is true for exactly one ChatView at a time (the on-screen one),
 * so gating on it makes exactly one session respond — the same fix already
 * used for the Ctrl/Cmd+F find-bar listener a few dozen lines below in
 * ChatView.tsx ("Only the visible ChatView responds (one per session is
 * mounted)"). Do not remove this gate or key it on something else — it is
 * the whole fix.
 */
export function useSessionPreviewListener(sessionId: string, visible: boolean, dispatch: (a: any) => void): void {
  useEffect(() => {
    // Hook itself always runs (rules of hooks); only the listener registration
    // is conditional, exactly like the Ctrl/Cmd+F effect this is patterned on.
    if (!visible) return;
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
  }, [sessionId, visible, dispatch]);
}
