import React from 'react';
import { ChatMessage } from '../../shared/types';
import MarkdownContent from './MarkdownContent';
import { formatBubbleTime } from '../utils/format-time';

interface Props {
  message: ChatMessage;
  /** TranscriptEvent.data.injected — which host mechanism wrote this turn. */
  injected: string;
  sessionId: string;
  showTimestamps: boolean;
}

// Header copy per injected kind. Unknown kinds still get a truthful generic
// label rather than falling back to the user bubble — the one thing this
// component must never do is present host-written text as the user's own.
function labelFor(injected: string): string {
  switch (injected) {
    case 'specialist-report': return 'Specialist report';
    default: return 'System message';
  }
}

/**
 * A user-ROLE turn the host wrote, not the user (2026-08-16). Today that is a
 * background specialist's delivered report (harness-session.ts runNotice,
 * `injected: 'specialist-report'`): the parent model reads it as its next
 * turn, so it lives in the user role on the wire — but drawing it in the
 * user's accent bubble on the user's side said "you typed this" about text
 * the user never wrote (Destin, 1b hands-on: "these task notifications don't
 * seem like they should be rendering as user messages").
 *
 * Rendered LEFT-aligned in the assistant-side inset style with a small
 * caps label, and the body goes through MarkdownContent so the report's own
 * `## Report from …` heading and bullet lists render instead of showing raw
 * `##`/backticks the way the plain-text user bubble did.
 */
export default React.memo(function InjectedNoticeBubble({ message, injected, sessionId, showTimestamps }: Props) {
  return (
    <div className="flex justify-start px-4 py-2" data-testid="injected-notice" data-injected={injected}>
      <div className="assistant-bubble max-w-[85%] min-w-0 rounded-2xl rounded-bl-sm bg-inset px-5 py-3 text-sm border border-edge-dim">
        <div className="text-2xs uppercase tracking-wide text-fg-muted select-none mb-1.5">
          {labelFor(injected)}
        </div>
        <MarkdownContent content={message.content} sessionId={sessionId} />
        {showTimestamps && (
          <div className="bubble-timestamp text-4xs text-fg-muted text-right mt-1 -mb-0.5 select-none leading-none">
            {formatBubbleTime(message.timestamp)}
          </div>
        )}
      </div>
    </div>
  );
});
