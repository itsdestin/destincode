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
import { TOOL_BTN_ACCENT, TOOL_BTN_NEUTRAL, PlayIcon } from './detail-tool-icons';

interface ConversationPreviewProps {
  project: { path: string };
  session: PastSession;
  onClose: () => void;
  onResume: (session: PastSession) => void;
}

// Compact relative-time for the meta strip (mirrors ConversationsTab's row hint).
function relTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString();
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

  // Total message count: the enriched ConversationSummary carries messageCount
  // (untyped on PastSession); fall back to however many we've loaded.
  const totalMessages = (session as any).messageCount as number | undefined;
  const shownCount = messages.length;
  const metaCount = all ? shownCount : (totalMessages ?? shownCount);
  // Footer only when we know there are more than the preview slice shows.
  const showFooter = !all && typeof totalMessages === 'number' && totalMessages > shownCount;

  // Header tools: Resume (accent) + Open full transcript (neutral).
  const tools = (
    <>
      <button type="button" className={TOOL_BTN_ACCENT} onClick={() => onResume(session)}>
        <PlayIcon size={13} />
        Resume in Claude
      </button>
      <button type="button" className={TOOL_BTN_NEUTRAL} onClick={loadFullTranscript} disabled={all}>
        {all ? 'Showing full transcript' : 'Open full transcript'}
      </button>
    </>
  );

  // Meta strip: "N messages · 2d ago · read-only preview".
  const meta = (
    <>
      <span>{metaCount} messages</span>
      <span className="text-fg-faint">·</span>
      <span>{relTime(session.lastModified)}</span>
      <span className="text-fg-faint">·</span>
      <span>read-only preview</span>
    </>
  );

  return (
    <ProjectDetailOverlay title={session.name || 'Untitled'} onClose={onClose} tools={tools} meta={meta}>
      {/* Message list */}
      <div className="px-5 py-4">
        {loading ? (
          <p className="text-sm text-fg-muted">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-fg-muted">No messages to preview.</p>
        ) : (
          <div className="max-w-[680px] mx-auto">
            {messages.map((m, i) => (
              <div key={i} className="mb-4">
                <div className={`text-[10px] font-medium tracking-wider uppercase mb-1.5 ${
                  m.role === 'user' ? 'text-fg-2' : 'text-fg-muted'
                }`}>
                  {m.role === 'user' ? 'You' : 'Claude'}
                </div>
                {/* Plain text only — whitespace-pre-wrap + break-words. We do NOT
                    execute markdown/HTML here; this is a lightweight read-only preview. */}
                <div
                  className={`text-[13px] text-fg-2 rounded-lg px-3.5 py-2.5 whitespace-pre-wrap break-words border ${
                    m.role === 'user'
                      ? 'bg-inset border-edge'
                      : 'bg-canvas border-edge-dim'
                  }`}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {showFooter && (
              <div className="text-center text-[11.5px] text-fg-muted py-2">
                — showing last {shownCount} of {totalMessages} messages —
              </div>
            )}
          </div>
        )}
      </div>
    </ProjectDetailOverlay>
  );
}
