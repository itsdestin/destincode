import React from 'react';
import { ChatMessage } from '../../shared/types';
import LinkableText from './LinkableText';
import { splitFlowingKeywords } from './FlowingKeywords';
import { formatBubbleTime } from '../utils/format-time';
import { detectFilepaths } from '../hooks/useInlineFilepathDetector';
import { FilepathToken } from './FilepathToken';

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

export default React.memo(function UserMessage({ message, sessionId, showTimestamps }: Props) {
  const content = message.content;
  // Detect filepaths (incl. attached files/images — their paths are joined into
  // the sent message text by InputBar) and render each as a clickable pill that
  // opens in the artifact viewer, same as assistant messages. Non-path spans keep
  // the flowing-keyword + URL-link treatment. NOTE: this covers the LIVE bubble;
  // a reloaded-from-transcript message loses attachment paths (the transcript
  // stores images as blocks, not paths), so pills there fall back to plain text.
  const matches = detectFilepaths(content);

  let body: React.ReactNode[];
  if (matches.length === 0) {
    body = renderTextRun(content, 't');
  } else {
    body = [];
    let cursor = 0;
    matches.forEach((m, mi) => {
      if (m.start > cursor) body.push(...renderTextRun(content.slice(cursor, m.start), `t${mi}`));
      body.push(<FilepathToken key={`p${mi}`} path={m.path} sessionId={sessionId} />);
      cursor = m.end;
    });
    if (cursor < content.length) body.push(...renderTextRun(content.slice(cursor), 'tend'));
  }

  return (
    <div className="flex justify-end px-4 py-2">
      <div className="user-bubble max-w-[80%] break-words rounded-2xl rounded-br-sm bg-accent px-5 py-3 text-sm text-on-accent whitespace-pre-wrap">
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
