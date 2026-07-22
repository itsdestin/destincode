import React from 'react';
import { Button } from './ui';

// Task 12: renders messages the native host FIFO'd behind an in-flight turn
// (SessionChatState.queuedMessages) docked at the bottom of the chat area —
// NOT as timeline entries. This replaces Task 3/11's queued `USER_PROMPT`
// timeline bubble + UserMessage's Cancel/Edit affordances: that design
// appended the bubble to the timeline at ENQUEUE time, but the streaming
// assistant turn's timeline entry is created lazily on its FIRST delta — so
// content arriving after the enqueue rendered BELOW the queued bubble and
// stayed there once the in-place confirm froze that position ("assistant
// responding to itself"). A queued message now joins the timeline for the
// first time when the host actually drains it (TRANSCRIPT_USER_MESSAGE's
// no-pending-match fallback in chat-reducer.ts), which always appends at the
// true, current end of the timeline.
//
// Known accepted limit: this list is renderer-local state. A reload loses the
// strip's visual rows while the host queue keeps draining underneath it —
// confirms still land correctly in the timeline; the rows just don't come
// back until a fresh QUEUED_MESSAGE_ADDED (there isn't one, since the reload
// didn't send anything). Rehydrating from the host's live queue on connect is
// a possible later nicety, not required here. Remote clients that didn't
// enqueue the message also never see it in their own strip — same
// renderer-local scope.

interface QueuedMessage {
  queueId: string;
  content: string;
  timestamp: number;
}

interface Props {
  sessionId: string;
  queuedMessages: QueuedMessage[];
  // Cancel/Edit — App owns the native:queue-remove invoke, the
  // QUEUED_MESSAGE_REMOVED dispatch (on BOTH outcomes — see App.tsx
  // handleCancelQueued/handleEditQueued), and the too-late toast. This
  // component is a pure callback-prop presentational piece, mirroring how
  // UserMessage's Task 11 affordances were wired (ChatView threads
  // sessionId + queueId through, no IPC/dispatch happens here).
  onCancel?: (queueId: string) => void;
  onEdit?: (queueId: string, text: string) => void;
}

export default function QueuedMessagesStrip({ queuedMessages, onCancel, onEdit }: Props) {
  if (queuedMessages.length === 0) return null;

  return (
    <div
      className="queued-messages-strip absolute left-3 right-3 z-10 flex flex-col gap-1.5"
      aria-label="Queued messages"
    >
      {queuedMessages.map((q) => (
        <div
          key={q.queueId}
          className="layer-surface flex items-center gap-2 rounded-xl px-3 py-2 shadow-lg"
        >
          <div className="text-[9px] uppercase tracking-wider text-fg-muted select-none shrink-0">
            Queued
          </div>
          <div className="flex-1 min-w-0 truncate text-sm text-fg-2">{q.content}</div>
          {(onEdit || onCancel) && (
            <div className="flex items-center gap-0.5 shrink-0">
              {onEdit && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Edit queued message"
                  onClick={() => onEdit(q.queueId, q.content)}
                  className="w-6 h-6 rounded-full text-fg-dim hover:text-fg text-xs leading-none"
                >
                  ✎
                </Button>
              )}
              {onCancel && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Cancel queued message"
                  onClick={() => onCancel(q.queueId)}
                  className="w-6 h-6 rounded-full text-fg-dim hover:text-fg text-xs leading-none"
                >
                  ✕
                </Button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
