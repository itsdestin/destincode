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
 * WHY the `sessionActive` gate (not `visible`): App.tsx mounts one ChatView
 * PER OPEN SESSION TAB and keeps background tabs mounted (sessions.map in
 * App.tsx), so this hook runs once per open tab. The `youcoded:preview-session`
 * event is a plain window event with no session id in it — every listener
 * that's live hears every click. Without a gate, clicking Preview in one tab
 * dispatched SESSION_REFERENCED/SESSION_PREVIEW_SET in EVERY open tab at once,
 * force-opening each one's drawer and nulling out whatever artifact it had
 * open. This hook's actual job is "route the event to the active session" —
 * the chat/terminal toggle is incidental to that. `visible` (App.tsx:
 * `s.id === sessionId && viewMode === 'chat'`) used to gate this, but it goes
 * false the moment the active session's tab is on Terminal, even though that
 * session is still the one a Preview click (e.g. from the SessionDrawer
 * TerminalRightSlot renders alongside the terminal) means to reach.
 * `sessionActive` (App.tsx: `s.id === sessionId`) is true for exactly one
 * ChatView regardless of chat/terminal — same "exactly one listener"
 * guarantee, without the false coupling to which tab is on screen. Do not
 * remove this gate or key it on `visible` again — it is the whole fix.
 */
export function useSessionPreviewListener(sessionId: string, sessionActive: boolean, dispatch: (a: any) => void): void {
  useEffect(() => {
    // Hook itself always runs (rules of hooks); only the listener registration
    // is conditional, exactly like the Ctrl/Cmd+F effect this is patterned on.
    if (!sessionActive) return;
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
  }, [sessionId, sessionActive, dispatch]);
}
