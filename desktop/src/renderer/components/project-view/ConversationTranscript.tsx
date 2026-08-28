// The read-only bubble list, shared by Project View's ConversationPreview and
// the Session Drawer's SessionPreviewPane. Markdown ON (code blocks and lists
// in a past conversation are unreadable as raw text); sessionId OFF (file
// chips would resolve against the CURRENT session's folder, which is usually
// not where this conversation happened).
import { useEffect, useRef } from 'react';
import MarkdownContent from '../MarkdownContent';
import { TerminalIcon } from '../Icons';
import type { HistoryMessage } from '../../../shared/types';
import { COPY } from '../../../shared/chatsearch-refs';

export type TranscriptRow = HistoryMessage & { seq?: number; droppedToolCalls?: number };

export default function ConversationTranscript({ messages, olderHint, scrollToEndKey, conversationId, conversationTitle }: {
  messages: TranscriptRow[];
  /** Rendered above the first message, e.g. a Load older button. */
  olderHint?: React.ReactNode;
  /** Change this value to jump to the newest message (initial load). */
  scrollToEndKey?: unknown;
  /**
   * Set ONLY by a caller previewing a specific past conversation (today:
   * SessionPreviewPane) — never by ConversationPreview (Project View), which
   * has no chatsearch-indexed id to offer. Presence is what lets the
   * right-click menu fire here at all (build-menu.ts widens its `.chat-scroll`
   * gate to also accept this container), and what lets its "Ask about this"
   * scaffold name the conversation instead of a bare quote — see
   * docs/active/specs/2026-08-26-conversation-preview-header-design.md §A3.
   */
  conversationId?: string;
  conversationTitle?: string;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [scrollToEndKey]);
  return (
    // w-full + min-w-0: this sits inside .drawer-pane, which collapses to 100%
    // on narrow screens WITHOUT resizing children (.claude/rules/narrow-viewport.md).
    // data-conversation-id/-title: React drops both when conversationId is
    // undefined, so ConversationPreview (which never passes it) renders
    // neither attribute and its right-click behaviour is untouched.
    <div className="w-full min-w-0 max-w-[680px] mx-auto" data-conversation-id={conversationId} data-conversation-title={conversationTitle}>
      {olderHint}
      {messages.map((m, i) => (
        <div key={m.seq ?? i}>
          {!!m.droppedToolCalls && (
            // The reader dropped tool activity here. Say so — a seamless join
            // would present an edited conversation as the whole one.
            // Destin (2026-08-27 gate, M-toolgap): draw it as a tool card, not
            // a centred dash line — same border/padding/`|` separator as the
            // real group header in AssistantTurnBubble.tsx, so a gap in a past
            // conversation looks like what it is. No chevron and no button:
            // there is nothing behind it to open.
            <div className="my-2 flex justify-start">
              {/* Byte-for-byte the collapsed tool-group header from
                  AssistantTurnBubble.tsx — glyph, the `|` separator, the label,
                  same border/radius/padding — with two deliberate differences:
                  no chevron, because there is nothing behind this to open, and
                  it sizes to its own text rather than filling the row, since a
                  full-width card with an empty right end is what made it read
                  as a stretched pill instead of a tool card.
                  The glyph is the terminal mark, NOT the check the real header
                  shows on success: the reader dropped these tools without
                  reading their results, so claiming they all completed would be
                  asserting something nobody checked. */}
              <div className="w-fit max-w-[85%] border border-edge rounded-lg px-3 py-1.5 flex items-center gap-1.5">
                <TerminalIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
                <span className="text-fg-faint text-xs select-none">|</span>
                <span className="text-xs text-fg-dim">{COPY.toolsNotShown(m.droppedToolCalls)}</span>
              </div>
            </div>
          )}
          <div className={`mb-3 flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {/* user-bubble / assistant-bubble: the SAME hook classes the real
                chat's UserMessage.tsx / AssistantTurnBubble.tsx carry. Theme
                packs' custom_css targets these names directly (they're on
                theme-validator.ts's KNOWN_THEME_HOOKS allowlist) — without
                them, a theme that restyles chat bubbles (border, glow, shadow)
                silently skips this read-only preview, so the same conversation
                looks like two different apps depending which surface it's
                viewed from. This does not change layout/geometry, only which
                selectors can reach these nodes. */}
            <div className={`min-w-0 break-words rounded-2xl px-5 py-3 text-sm ${m.role === 'user' ? 'user-bubble max-w-[80%] rounded-br-sm bg-accent text-on-accent' : 'assistant-bubble max-w-[85%] rounded-bl-sm bg-inset text-fg'}`}>
              <MarkdownContent content={m.content} />
            </div>
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
