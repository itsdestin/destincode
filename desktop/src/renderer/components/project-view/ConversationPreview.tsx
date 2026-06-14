// ConversationPreview — read-only transcript preview shown in the shared centered
// detail overlay (Task 3.2). Loads a session's message history via the
// project:conversation-history IPC (which does NOT launch Claude — it parses the
// JSONL transcript on disk) and renders it as role-labelled plain-text blocks.
//
// IMPORTANT: This component NEVER spawns a Claude process. Only the explicit
// "Resume in Claude" button leads to a live session, and that is handled entirely
// by the parent via the `onResume` prop. "Open full transcript" just re-fetches
// the same read-only history with `all: true`.
import React, { useEffect, useState } from 'react';
import type { PastSession, HistoryMessage } from '../../../shared/types';
import { ProjectDetailOverlay } from './ProjectDetailOverlay';

interface ConversationPreviewProps {
  project: { path: string };
  session: PastSession;
  onClose: () => void;
  onResume: (session: PastSession) => void;
}

export function ConversationPreview({ project, session, onClose, onResume }: ConversationPreviewProps) {
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [loading, setLoading] = useState(true);
  // `all` flips to true once the user clicks "Open full transcript"; we re-fetch
  // with count=0/all=true and disable the button so a second click is a no-op.
  const [all, setAll] = useState(false);

  // Load the (preview-length) history on mount and whenever the session changes.
  // A `cancelled` flag guards against a late response from a previous session
  // overwriting the current one (the overlay can be reused for a new session
  // without unmounting if the parent swaps `session` in place).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setAll(false);
    setMessages([]);
    (async () => {
      try {
        const res = await (window.claude as any).project.conversationHistory(
          project.path, session.sessionId, 20, false,
        );
        if (cancelled) return;
        setMessages(res?.ok ? (res.messages ?? []) : []);
      } catch {
        if (!cancelled) setMessages([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [session.sessionId, project.path]);

  // "Open full transcript" — re-fetch the same read-only history with all=true.
  // Still no Claude launch; this just reads more lines from the same JSONL.
  const loadFullTranscript = async () => {
    setLoading(true);
    try {
      const res = await (window.claude as any).project.conversationHistory(
        project.path, session.sessionId, 0, true,
      );
      setMessages(res?.ok ? (res.messages ?? []) : []);
      setAll(true);
    } catch {
      /* leave current messages in place on failure */
    } finally {
      setLoading(false);
    }
  };

  return (
    <ProjectDetailOverlay title={session.name || 'Untitled'} onClose={onClose}>
      {/* Header action row — sticky so the actions stay reachable while scrolling. */}
      <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-2.5 bg-panel border-b border-edge-dim">
        <button
          type="button"
          className="px-3.5 py-1.5 rounded-md bg-accent text-on-accent text-xs font-medium hover:opacity-90 transition-opacity"
          onClick={() => onResume(session)}
        >
          Resume in Claude
        </button>
        <button
          type="button"
          className="px-3 py-1.5 rounded-md bg-inset text-fg-2 border border-edge-dim hover:text-fg hover:border-edge text-xs transition-colors disabled:opacity-50 disabled:cursor-default"
          onClick={loadFullTranscript}
          disabled={all}
        >
          {all ? 'Showing full transcript' : 'Open full transcript'}
        </button>
        <div className="flex-1" />
        <span className="text-[11px] text-fg-muted shrink-0">read-only preview</span>
      </div>

      {/* Message list */}
      <div className="px-4 py-4">
        {loading ? (
          <p className="text-sm text-fg-muted">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-fg-muted">No messages to preview.</p>
        ) : (
          <div className="max-w-[680px] mx-auto">
            {messages.map((m, i) => (
              <div key={i} className="mb-4">
                <div className="text-[10px] tracking-wider uppercase text-fg-muted mb-1.5">
                  {m.role === 'user' ? 'You' : 'Claude'}
                </div>
                {/* Plain text only — whitespace-pre-wrap + break-words. We do NOT
                    execute markdown/HTML here; this is a lightweight read-only preview. */}
                <div
                  className={`text-[13px] text-fg-2 rounded-lg px-3.5 py-2.5 whitespace-pre-wrap break-words ${
                    m.role === 'user'
                      ? 'bg-inset border border-edge'
                      : 'border border-edge-dim'
                  }`}
                >
                  {m.content}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </ProjectDetailOverlay>
  );
}
