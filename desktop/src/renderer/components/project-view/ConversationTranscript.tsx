// The read-only bubble list, shared by Project View's ConversationPreview and
// the Session Drawer's SessionPreviewPane. Markdown ON (code blocks and lists
// in a past conversation are unreadable as raw text); sessionId OFF (file
// chips would resolve against the CURRENT session's folder, which is usually
// not where this conversation happened).
import { useEffect, useRef } from 'react';
import MarkdownContent from '../MarkdownContent';
import type { HistoryMessage } from '../../../shared/types';
import { COPY } from '../../../shared/chatsearch-refs';

export type TranscriptRow = HistoryMessage & { seq?: number; droppedToolCalls?: number };

export default function ConversationTranscript({ messages, olderHint, scrollToEndKey }: {
  messages: TranscriptRow[];
  /** Rendered above the first message, e.g. a Load older button. */
  olderHint?: React.ReactNode;
  /** Change this value to jump to the newest message (initial load). */
  scrollToEndKey?: unknown;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [scrollToEndKey]);
  return (
    // w-full + min-w-0: this sits inside .drawer-pane, which collapses to 100%
    // on narrow screens WITHOUT resizing children (.claude/rules/narrow-viewport.md).
    <div className="w-full min-w-0 max-w-[680px] mx-auto">
      {olderHint}
      {messages.map((m, i) => (
        <div key={m.seq ?? i}>
          {!!m.droppedToolCalls && (
            // The reader dropped tool activity here. Say so — a seamless join
            // would present an edited conversation as the whole one.
            <div className="my-2 text-center text-[11.5px] text-fg-muted">— {COPY.toolsNotShown(m.droppedToolCalls)} —</div>
          )}
          <div className={`mb-3 flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`min-w-0 break-words rounded-2xl px-5 py-3 text-sm ${m.role === 'user' ? 'max-w-[80%] rounded-br-sm bg-accent text-on-accent' : 'max-w-[85%] rounded-bl-sm bg-inset text-fg'}`}>
              <MarkdownContent content={m.content} />
            </div>
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
