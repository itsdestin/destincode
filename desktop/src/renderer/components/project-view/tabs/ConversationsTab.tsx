// ConversationsTab — flat list of past conversations scoped to one project
// (Task 3.1). The list is fetched ONCE by ProjectView (shared with the hero
// count + cached per project) and passed in as a prop — this tab no longer
// fetches on its own, which removed the duplicate enumeration that ran on every
// project switch / tab toggle. Each row matches the prototype's convRow: an icon
// avatar + title/time + a one-line preview. Rows use
// `bg-panel border border-edge-dim rounded-lg` (NOT .layer-surface — its
// overflow:hidden + flex compression clips the text). No ●◐○ status glyphs.
import React from 'react';
import type { PastSession } from '../../../../shared/types';
// Relative-time formatter for the per-row time hint (shared util).
import { formatRelativeTime } from '../../../utils/format-time';

// Enriched session shape returned by project:list-conversations.
interface ConversationSummary extends PastSession {
  preview?: string;
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
  // Lifted, cached list from ProjectView. null = still loading for this project.
  conversations: ConversationSummary[] | null;
  onOpenPreview: (session: PastSession) => void;
}

export function ConversationsTab({ conversations, onOpenPreview }: ConversationsTabProps) {
  const loading = conversations === null;
  const rows = conversations ?? [];

  return (
    <div className="flex flex-col h-full overflow-hidden px-4 pt-1 pb-4 min-w-0">
      {loading ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-fg-muted">No conversations in this project yet.</p>
      ) : (
        <div className="flex-1 overflow-auto flex flex-col gap-2 content-start">
          {rows.map((c) => {
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
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
