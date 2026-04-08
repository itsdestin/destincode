import React from 'react';
import { ChatMessage } from '../../shared/types';
import LinkableText from './LinkableText';
import { formatBubbleTime } from '../utils/format-time';

interface Props {
  message: ChatMessage;
  showTimestamps: boolean;
}

export default React.memo(function UserMessage({ message, showTimestamps }: Props) {
  return (
    <div className="flex justify-end px-4 py-2">
      <div className="user-bubble max-w-[80%] rounded-2xl rounded-br-sm bg-accent px-5 py-3 text-sm text-on-accent whitespace-pre-wrap">
        <LinkableText text={message.content} />
        {showTimestamps && (
          <div className="bubble-timestamp text-[9px] text-on-accent/50 text-right mt-1 -mb-0.5 select-none leading-none">
            {formatBubbleTime(message.timestamp)}
          </div>
        )}
      </div>
    </div>
  );
});
