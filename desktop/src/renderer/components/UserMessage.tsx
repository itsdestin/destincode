import React, { useState } from 'react';
import { ChatMessage } from '../../shared/types';
import LinkableText from './LinkableText';
import { splitFlowingKeywords } from './FlowingKeywords';
import { formatBubbleTime } from '../utils/format-time';
import { detectFilepaths } from '../hooks/useInlineFilepathDetector';
import { FilepathToken } from './FilepathToken';
import { parseReferencePrompt, type ParsedReference } from './context-menu/reference-prompt';
import { Button } from './ui/Button';

interface Props {
  message: ChatMessage;
  sessionId: string;
  showTimestamps: boolean;
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

// Filepath-pill + flowing-keyword treatment shared by the plain-message body
// AND a reference reply's follow-up text — one copy so the two can't drift.
function renderMessageBody(text: string, sessionId: string, keyPrefix: string): React.ReactNode[] {
  const matches = detectFilepaths(text);
  if (matches.length === 0) return renderTextRun(text, keyPrefix);
  const out: React.ReactNode[] = [];
  let cursor = 0;
  matches.forEach((m, mi) => {
    if (m.start > cursor) out.push(...renderTextRun(text.slice(cursor, m.start), `${keyPrefix}${mi}`));
    out.push(<FilepathToken key={`${keyPrefix}p${mi}`} path={m.path} sessionId={sessionId} />);
    cursor = m.end;
  });
  if (cursor < text.length) out.push(...renderTextRun(text.slice(cursor), `${keyPrefix}end`));
  return out;
}

// Quote collapse threshold (spec 2026-07-26 inline-reply follow-up): a quoted
// reference clamps when it exceeds ~3 lines OR ~240 characters, whichever
// trips first. 240 chars is roughly what a bubble at max-w-[80%] wraps to in
// 3 lines at the chat pane's default width, so the char check is the one that
// actually fires for realistic content — see the char-vs-line note on
// isLongQuote below for why the line check still exists.
const COLLAPSE_CHAR_THRESHOLD = 240;
const COLLAPSE_LINE_THRESHOLD = 3;

function isLongQuote(q: string): boolean {
  return q.length > COLLAPSE_CHAR_THRESHOLD || q.split('\n').length > COLLAPSE_LINE_THRESHOLD;
}

// Clamp to whichever bound is tighter, so a quote that's short-but-tall (many
// short lines) and one that's long-but-flat (one giant line, the common case
// once InputBar's sanitize has flattened embedded newlines to spaces — see
// reference-prompt.ts's header comment) both collapse sensibly.
function clampQuote(q: string): string {
  const lines = q.split('\n');
  const byLines = lines.length > COLLAPSE_LINE_THRESHOLD ? lines.slice(0, COLLAPSE_LINE_THRESHOLD).join('\n') : q;
  return byLines.length > COLLAPSE_CHAR_THRESHOLD ? byLines.slice(0, COLLAPSE_CHAR_THRESHOLD) : byLines;
}

/** The quoted-reference strip inside a user bubble. Collapsed by default when
 *  long — the toggle is a real <Button> (design rule: every control goes
 *  through components/ui/), with its label recolored via a child <span>
 *  rather than a className override: Button's CONFLICT_GROUPS (see its own
 *  header comment) doesn't arbitrate text-color classes, so overriding the
 *  button's own `text-fg-dim` by className would race Tailwind's generation
 *  order. A child span's own explicit color always wins over an ancestor's,
 *  with no such race — CSS inheritance, not utility-class precedence. */
function ReferenceQuote({ quote, fenced }: { quote: string; fenced: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const long = isLongQuote(quote);
  const shown = long && !expanded ? clampQuote(quote) : quote;
  return (
    <div className="border-l-2 border-on-accent/40 pl-2 mb-1">
      <div className={`text-xs text-on-accent/70 whitespace-pre-wrap break-words ${fenced ? 'font-mono' : 'italic'}`}>
        {shown}
        {long && !expanded && '…'}
      </div>
      {long && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-0.5 -ml-1.5"
          onClick={() => setExpanded((e) => !e)}
        >
          <span className="text-on-accent/60">{expanded ? 'Show less' : 'Show more'}</span>
        </Button>
      )}
    </div>
  );
}

function baseName(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() || p;
}

/** Compact one-line summary for an artifact reference — no collapsing needed,
 *  it's already a short descriptor ("lines 12-14 of chat-reducer.ts"), not a
 *  quoted body. */
function artifactSummary(descriptor: string, path: string): string {
  return descriptor.startsWith('line') ? `${descriptor} of ${baseName(path)}` : `${descriptor} — ${baseName(path)}`;
}

function ReferenceReplyBody({ parsed, sessionId }: { parsed: ParsedReference; sessionId: string }) {
  const followUp = renderMessageBody(parsed.followUp, sessionId, 'f');
  if (parsed.kind === 'artifact') {
    return (
      <>
        <div className="mb-1 border-l-2 border-on-accent/40 pl-2 text-xs italic text-on-accent/70">
          Referencing {artifactSummary(parsed.descriptor, parsed.path)}
        </div>
        {followUp}
      </>
    );
  }
  return (
    <>
      <ReferenceQuote quote={parsed.quote} fenced={parsed.fenced} />
      {followUp}
    </>
  );
}

export default React.memo(function UserMessage({ message, sessionId, showTimestamps }: Props) {
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

  // Ask Claude About This (spec 2026-07-26): the timeline entry now stores the
  // TRUE sent text — scaffold included — so TRANSCRIPT_USER_MESSAGE's
  // content-equality dedup can actually match it (see InputBar.tsx's send()
  // fix). That means a referenced message's `content` is the raw scaffold
  // string, not just the user's words — recover the pieces here and render
  // an inline reply block instead of dumping the scaffold as plain text.
  const parsed = parseReferencePrompt(text);

  // Detect filepaths in the (remaining) typed text and render each as a
  // clickable pill that opens in the artifact viewer, same as assistant
  // messages. Non-path spans keep the flowing-keyword + URL-link treatment.
  // NOTE: this covers the LIVE bubble; a reloaded-from-transcript message
  // loses attachment paths (the transcript stores images as blocks, not
  // paths), so pills there fall back to plain text.
  const body: React.ReactNode[] = parsed
    ? [<ReferenceReplyBody key="ref" parsed={parsed} sessionId={sessionId} />]
    : renderMessageBody(text, sessionId, 't');
  const rendered = [...attachmentPills, ...body];

  return (
    <div className="flex justify-end px-4 py-2">
      <div className="user-bubble max-w-[80%] break-words rounded-2xl rounded-br-sm bg-accent px-5 py-3 text-sm text-on-accent whitespace-pre-wrap">
        {rendered}
        {showTimestamps && (
          <div className="bubble-timestamp text-4xs text-on-accent/50 text-right mt-1 -mb-0.5 select-none leading-none">
            {formatBubbleTime(message.timestamp)}
          </div>
        )}
      </div>
    </div>
  );
});
