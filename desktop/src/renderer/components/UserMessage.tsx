import React from 'react';
import { ChatMessage } from '../../shared/types';
import LinkableText from './LinkableText';
import { splitFlowingKeywords } from './FlowingKeywords';
import { formatBubbleTime } from '../utils/format-time';
import { detectFilepaths } from '../hooks/useInlineFilepathDetector';
import { FilepathToken } from './FilepathToken';
import { Button } from './ui';

interface Props {
  message: ChatMessage;
  sessionId: string;
  showTimestamps: boolean;
  // M1: true while a native send is FIFO'd behind the in-flight turn
  // (NativeSendResult status 'queued') — only meaningful alongside
  // pending: true, since the confirm path (TRANSCRIPT_USER_MESSAGE) drops
  // `queued` the same moment it clears `pending`. See chat-reducer.ts.
  pending?: boolean;
  queued?: boolean;
  // Task 11: the host-minted id for this queued entry (chat-types.ts
  // TimelineEntry.queueId) — required by both affordances below to identify
  // which queued send to target. Absent whenever queued isn't true.
  queueId?: string;
  // Task 11: Cancel/Edit affordances on a queued bubble. Both are plain
  // callbacks (no IPC/dispatch here) — ChatView wires the actual
  // native:queue-remove invoke + dispatch, mirroring how ChatView wires
  // ModelLoadingBar's onReload inline rather than threading window.claude
  // through this presentational component. Rendered only when BOTH the
  // handler is provided AND queueId is present.
  onCancelQueued?: (queueId: string) => void;
  onEditQueued?: (queueId: string, text: string) => void;
}

// Render a plain-text run with the existing treatment: flowing-keyword spans +
// URL linking. Used for the text BETWEEN detected filepaths.
function renderTextRun(text: string, keyPrefix: string): React.ReactNode[] {
  return splitFlowingKeywords(text).map((seg, i) =>
    seg.flowing ? (
      <span key={`${keyPrefix}-${i}`} className="flowing-word">{seg.text}</span>
    ) : (
      <LinkableText key={`${keyPrefix}-${i}`} text={seg.text} />
    ),
  );
}

export default React.memo(function UserMessage({ message, sessionId, showTimestamps, pending, queued, queueId, onCancelQueued, onEditQueued }: Props) {
  const content = message.content;

  // Attached files: message.attachments carries the EXACT picker paths (which
  // routinely contain spaces the joined content string can't be split back out
  // of). By construction (InputBar), content = attachments space-joined + the
  // typed text — strip the known prefix so the remainder is just the text.
  // Falls back gracefully: if the prefix doesn't line up, everything renders
  // through the regex path like before.
  const attachments = message.attachments ?? [];
  let text = content;
  const attachmentPills: React.ReactNode[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const p = attachments[i];
    if (!text.startsWith(p)) break;
    text = text.slice(p.length).replace(/^ /, '');
    attachmentPills.push(<FilepathToken key={`a${i}`} path={p} sessionId={sessionId} />);
    if (i < attachments.length - 1 || text.length > 0) attachmentPills.push(' ');
  }

  // Detect filepaths in the (remaining) typed text and render each as a
  // clickable pill that opens in the artifact viewer, same as assistant
  // messages. Non-path spans keep the flowing-keyword + URL-link treatment.
  // NOTE: this covers the LIVE bubble; a reloaded-from-transcript message
  // loses attachment paths (the transcript stores images as blocks, not
  // paths), so pills there fall back to plain text.
  const matches = detectFilepaths(text);

  let body: React.ReactNode[];
  if (matches.length === 0) {
    body = renderTextRun(text, 't');
  } else {
    body = [];
    let cursor = 0;
    matches.forEach((m, mi) => {
      if (m.start > cursor) body.push(...renderTextRun(text.slice(cursor, m.start), `t${mi}`));
      body.push(<FilepathToken key={`p${mi}`} path={m.path} sessionId={sessionId} />);
      cursor = m.end;
    });
    if (cursor < text.length) body.push(...renderTextRun(text.slice(cursor), 'tend'));
  }
  body = [...attachmentPills, ...body];

  return (
    <div className="flex justify-end px-4 py-2">
      <div className="user-bubble max-w-[80%] break-words rounded-2xl rounded-br-sm bg-accent px-5 py-3 text-sm text-on-accent whitespace-pre-wrap">
        {queued && pending && (
          // M1: the send was FIFO'd behind the in-flight turn — this bubble
          // hasn't actually reached the host yet. text-on-accent/50 matches
          // the timestamp treatment just below (same bubble, same need for a
          // muted label against the accent background) — no new color token.
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="text-[9px] uppercase tracking-wider text-on-accent/50 select-none">
              Queued
            </div>
            {/* Task 11: Cancel/Edit — only when a queueId exists AND the
                caller wired a handler. Small icon buttons (16px, below the
                44dp touch guideline like the attachment remover in InputBar)
                sized down from Button's default 28px icon slot via className. */}
            {queueId && (onCancelQueued || onEditQueued) && (
              <div className="flex items-center gap-0.5 -mr-1">
                {onEditQueued && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Edit queued message"
                    onClick={() => onEditQueued(queueId, message.content)}
                    className="w-4 h-4 rounded-full text-on-accent/60 hover:text-on-accent hover:bg-on-accent/10 text-[10px] leading-none"
                  >
                    ✎
                  </Button>
                )}
                {onCancelQueued && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Cancel queued message"
                    onClick={() => onCancelQueued(queueId)}
                    className="w-4 h-4 rounded-full text-on-accent/60 hover:text-on-accent hover:bg-on-accent/10 text-[10px] leading-none"
                  >
                    ✕
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
        {body}
        {showTimestamps && (
          <div className="bubble-timestamp text-[9px] text-on-accent/50 text-right mt-1 -mb-0.5 select-none leading-none">
            {formatBubbleTime(message.timestamp)}
          </div>
        )}
      </div>
    </div>
  );
});
