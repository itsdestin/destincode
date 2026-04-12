import React from 'react';
import { ChatMessage } from '../../shared/types';
import LinkableText from './LinkableText';
import { splitFlowingKeywords } from './FlowingKeywords';
import { formatBubbleTime } from '../utils/format-time';

interface Props {
  message: ChatMessage;
  showTimestamps: boolean;
}

export default React.memo(function UserMessage({ message, showTimestamps }: Props) {
  // Split on flowing keywords first, then URL-link the non-keyword segments.
  // URLs never contain our keywords, so the order is safe.
  const segments = splitFlowingKeywords(message.content);
  return (
    <div className="flex justify-end px-4 py-2">
      <div className="user-bubble max-w-[80%] rounded-2xl rounded-br-sm bg-accent px-5 py-3 text-sm text-on-accent whitespace-pre-wrap">
        {segments.map((seg, i) =>
          seg.flowing ? (
            <span key={i} className="flowing-word">{seg.text}</span>
          ) : (
            <LinkableText key={i} text={seg.text} />
          ),
        )}
        {showTimestamps && (
          <div className="bubble-timestamp text-[9px] text-on-accent/50 text-right mt-1 -mb-0.5 select-none leading-none">
            {formatBubbleTime(message.timestamp)}
          </div>
        )}
      </div>
    </div>
  );
});
