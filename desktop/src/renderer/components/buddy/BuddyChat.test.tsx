// @vitest-environment jsdom
// Regression test for the CRITICAL finding: opening a Buddy companion window
// crashed blank. useReference() (reference-context.tsx) used to throw
// unconditionally when no ReferenceProvider ancestor was mounted, and
// InputBar calls useReference() on every render (placeholder text + send-time
// scaffold assembly). Both Buddy hosting strategies — BuddyChatApp.tsx
// (separate-window: Windows/macOS/X11) and BuddyOverlayApp.tsx (Linux
// Wayland overlay) — mount BuddyChat's `<InputBar ... compact />` under
// exactly `ThemeProvider > ChatProvider`, with NO ReferenceProvider (App.tsx:
// "Buddy windows render as isolated placeholders without main-app
// providers"), and the buddy early-returns happen before App.tsx's
// <ReferenceProvider> wrap with no ErrorBoundary around them. This test pins
// the exact provider stack the Buddy windows actually ship so it can't drift
// from BuddyChatApp.tsx/BuddyOverlayApp.tsx without someone noticing.
//
// There were previously NO tests anywhere under
// src/renderer/components/buddy/ — this is why the full green suite missed
// the regression; this file is the first.
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ThemeProvider } from '../../state/theme-context';
import { ChatProvider } from '../../state/chat-context';
import InputBar from '../InputBar';

// useScrollFade (mounted unconditionally by InputBar's textarea) reaches for
// ResizeObserver, which jsdom doesn't implement — same stub InputBar.test.tsx
// uses.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('InputBar under the Buddy provider stack (no ReferenceProvider)', () => {
  afterEach(() => {
    cleanup();
  });

  it('mounts without throwing — matches BuddyChatApp/BuddyOverlayApp exactly (ThemeProvider > ChatProvider, no ReferenceProvider)', () => {
    (global as any).ResizeObserver = NoopResizeObserver;

    // `compact` matches BuddyChat.tsx's actual usage (`<InputBar
    // sessionId={viewedSession} compact />`) — compact hides QuickChips,
    // which is the one other renderer piece under InputBar that reads a
    // context (SkillProvider) neither Buddy tree provides, so this render
    // faithfully reproduces what ships rather than papering over a second
    // missing provider.
    expect(() => {
      render(
        <ThemeProvider>
          <ChatProvider>
            <InputBar sessionId="buddy-session-1" compact />
          </ChatProvider>
        </ThemeProvider>,
      );
    }).not.toThrow();
  });
});
