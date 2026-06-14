// ConversationsTab — flat list of past conversations scoped to one project
// (Task 3.1). Fetches project-filtered past sessions (sorted newest-first,
// enriched with a preview + message count) and renders each as a row matching
// the prototype's convRow: an icon avatar + title/time + a one-line preview +
// a "N messages" line. Rows use `bg-panel border border-edge-dim rounded-lg`
// (NOT .layer-surface — its overflow:hidden + flex compression clips the text).
// No ●◐○ status glyphs anywhere — plain words/numbers only.
import React, { useEffect, useState } from 'react';
import type { PastSession } from '../../../../shared/types';

// Enriched session shape returned by project:list-conversations.
interface ConversationSummary extends PastSession {
  preview?: string;
  messageCount?: number;
}

// Relative-time formatter for the per-row time hint.
function formatRelativeTime(epochMs: number): string {
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

// Inline lucide-style chat glyph for the row avatar (matches the prototype).
function ChatGlyph({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

interface ConversationsTabProps {
  project: { path: string }; // active CentralIndexProject; only .path is needed here
  onOpenPreview: (session: PastSession) => void;
}

export function ConversationsTab({ project, onOpenPreview }: ConversationsTabProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);

  // Load project-filtered conversations on mount and whenever the project path
  // changes. `cancelled` guards against a late response overwriting the current
  // project's list after a fast switch.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (window.claude as any).project.listConversations(project.path)
      .then((res: any) => {
        if (cancelled) return;
        if (res && res.ok) setConversations(res.conversations ?? []);
        else setConversations([]);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setConversations([]);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [project.path]);

  return (
    <div className="flex flex-col h-full overflow-hidden px-4 pt-1 pb-4 min-w-0">
      {loading ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : conversations.length === 0 ? (
        <p className="text-sm text-fg-muted">No conversations in this project yet.</p>
      ) : (
        <div className="flex-1 overflow-auto flex flex-col gap-2 content-start">
          {conversations.map((c) => {
            const title = c.name?.trim() ? c.name : 'Untitled';
            return (
              // bg-panel + border + rounded-lg (NOT layer-surface). shrink-0 so
              // the scroll container doesn't compress rows and clip their text.
              <button
                key={c.sessionId}
                type="button"
                className="w-full text-left flex items-start gap-3 bg-panel border border-edge-dim rounded-lg p-3 shrink-0 hover:bg-inset hover:border-edge transition-colors"
                onClick={() => onOpenPreview(c)}
                title={title}
              >
                <span className="w-9 h-9 rounded-md shrink-0 inline-flex items-center justify-center bg-inset text-fg-dim mt-0.5">
                  <ChatGlyph size={17} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2 justify-between">
                    <span className="text-[13.5px] font-medium text-fg truncate">{title}</span>
                    <span className="text-[11px] text-fg-faint shrink-0">
                      {formatRelativeTime(c.lastModified)}
                    </span>
                  </span>
                  {c.preview ? (
                    <span className="block text-[12px] text-fg-2 truncate mt-0.5">{c.preview}</span>
                  ) : null}
                  <span className="block text-[10.5px] text-fg-muted mt-1.5">
                    {typeof c.messageCount === 'number' ? `${c.messageCount} messages` : ''}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
