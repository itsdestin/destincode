// ConversationsTab — flat list of past conversations scoped to one project
// (Task 3.1). Fetches project-filtered past sessions (sorted newest-first) and
// renders each as a .layer-surface row. Row click opens a preview (Task 3.2
// builds the actual preview overlay; here we just bubble the selection up).
// No ●◐○ status glyphs anywhere — plain words/numbers only (the glyph language
// is disliked).
import React, { useEffect, useState } from 'react';
import type { PastSession } from '../../../../shared/types';

// Relative-time formatter for the "active <when>" hint. Duplicated (6 lines)
// from ProjectView.tsx rather than lifted to a shared module — per the task
// guidance, duplicating a tiny formatter is the lower-risk option vs. exporting
// and threading a helper through the project-view subtree.
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

// Lightweight "length" signal from the transcript byte size (proxy for
// conversation length). Non-glyphy, KB/MB only.
function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface ConversationsTabProps {
  project: { path: string }; // active CentralIndexProject; only .path is needed here
  onOpenPreview: (session: PastSession) => void;
}

export function ConversationsTab({ project, onOpenPreview }: ConversationsTabProps) {
  const [conversations, setConversations] = useState<PastSession[]>([]);
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
    <div className="flex flex-col h-full overflow-hidden p-4 min-w-0">
      {loading ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : conversations.length === 0 ? (
        <p className="text-sm text-fg-muted">No conversations in this project yet.</p>
      ) : (
        <div className="flex-1 overflow-auto flex flex-col gap-2 content-start">
          {conversations.map((c) => {
            const title = c.name?.trim() ? c.name : 'Untitled';
            return (
              <button
                key={c.sessionId}
                type="button"
                className="layer-surface w-full text-left p-3 transition-colors hover:bg-inset"
                onClick={() => onOpenPreview(c)}
                title={title}
              >
                <div className="flex items-baseline gap-2 justify-between">
                  <span className="text-sm font-medium text-fg truncate">{title}</span>
                  <span className="text-[11px] text-fg-faint shrink-0">
                    {formatRelativeTime(c.lastModified)}
                  </span>
                </div>
                <div className="text-[11px] text-fg-muted mt-1">
                  {formatSize(c.size)}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
