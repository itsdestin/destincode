import { useEffect } from 'react';
import { ThemeProvider } from '../../state/theme-context';
import { ChatProvider } from '../../state/chat-context';
import { BuddyChat } from './BuddyChat';

export function BuddyChatApp() {
  useEffect(() => {
    document.body.setAttribute('data-mode', 'buddy-chat');
  }, []);

  return (
    <ThemeProvider>
      {/* ChatProvider is needed because BubbleFeed imports ToolCard which calls
          useChatDispatch() for permission approval responses. The buddy window
          has its own isolated React tree — it does NOT share the main window's
          ChatProvider instance. */}
      <ChatProvider>
        <BuddyChat />
      </ChatProvider>
    </ThemeProvider>
  );
}
