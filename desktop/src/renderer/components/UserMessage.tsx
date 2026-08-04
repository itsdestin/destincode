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

/** The quoted-reference strip inside a user bubble.
 *
 *  Destin picked options B+D from the dev-review mockup, which compose into one
 *  control rather than two: D's pill IS the collapsed state, B's labelled panel
 *  IS the expanded one. Collapsed by default so the bubble stays roughly the
 *  size of what the user actually typed — the reference is present without
 *  competing with their own words.
 *
 *  The toggle is a real <Button> (design rule: every control goes through
 *  components/ui/). Its label colour is set on a child <span>, not via a
 *  className override: Button's CONFLICT_GROUPS doesn't arbitrate text-colour
 *  classes, so overriding its own `text-fg-dim` by className would race
 *  Tailwind's generation order. A child span's explicit colour always wins over
 *  an ancestor's by plain inheritance, with no such race. */
function ReferenceQuote({
  quote,
  fenced,
  icon = '\u275D',
  label = 'Claude said',
}: {
  quote: string;
  fenced: boolean;
  icon?: string;
  label?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!expanded) {
    // Collapsed: a single pill. One line, ellipsised — never grows the bubble.
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setExpanded(true)}
        aria-expanded={false}
        className="reference-pill mb-1 flex items-center gap-1.5 max-w-full rounded-full px-2.5 py-0.5"
      >
        <span className="text-on-accent/60 shrink-0" aria-hidden="true">{icon}</span>
        <span className="text-on-accent/75 text-2xs truncate">{quote}</span>
      </Button>
    );
  }

  // Expanded: the labelled inset panel.
  return (
    <div className="reference-panel mb-1 rounded-md px-2.5 py-1.5">
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="text-on-accent/60 text-3xs shrink-0" aria-hidden="true">{icon}</span>
        <span className="text-on-accent/60 text-3xs uppercase tracking-wide">{label}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(false)}
          aria-expanded
          className="ml-auto px-1 py-0"
        >
          <span className="text-on-accent/60 text-3xs">Hide</span>
        </Button>
      </div>
      <div className={`text-xs text-on-accent/80 whitespace-pre-wrap break-words ${fenced ? 'font-mono' : ''}`}>
        {quote}
      </div>
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
        {/* An artifact reference is already a short descriptor
            ("lines 12-14 of chat-reducer.ts"), not a quoted body — it renders
            as the same pill shape but never needs to expand. */}
        <div className="reference-pill reference-pill--static mb-1 flex items-center gap-1.5 max-w-full rounded-full px-2.5 py-0.5">
          <span className="text-on-accent/60 shrink-0" aria-hidden="true">&#9707;</span>
          <span className="text-on-accent/75 text-2xs truncate">
            {artifactSummary(parsed.descriptor, parsed.path)}
          </span>
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
