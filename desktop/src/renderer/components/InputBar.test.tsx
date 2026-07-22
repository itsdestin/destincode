// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ChatProvider } from '../state/chat-context';
import { SkillProvider } from '../state/skill-context';
import InputBar from './InputBar';

// jsdom (per this repo's vitest.config.ts) has no global setupFiles/polyfills —
// useScrollFade (mounted unconditionally by InputBar's textarea) reaches for
// ResizeObserver, which jsdom doesn't implement. A no-op stub is enough since
// this test never asserts on the fade behavior itself.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('InputBar native send — failure keeps the draft (reviewer Critical fix)', () => {
  beforeEach(() => {
    (global as any).ResizeObserver = NoopResizeObserver;
    // Minimal window.claude surface: only native.send is exercised by this
    // test's path (provider='native', plain non-slash text, no attachments).
    // session.sendInput is stubbed defensively — the CC/PTY branch is never
    // reached here, but other InputBar effects/handlers reference it.
    (window as any).claude = {
      native: {
        supported: true,
        send: vi.fn(),
      },
      session: {
        sendInput: vi.fn(),
      },
      // QuickChips (rendered unconditionally by InputBar) reads skills via
      // SkillProvider — stub every call it makes on mount so the tree doesn't
      // throw. Empty lists are fine; this test never interacts with chips.
      skills: {
        list: vi.fn().mockResolvedValue([]),
        getFavorites: vi.fn().mockResolvedValue([]),
        getChips: vi.fn().mockResolvedValue([]),
        getCuratedDefaults: vi.fn().mockResolvedValue([]),
      },
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('restores the typed draft and shows a toast when the ack is failed', async () => {
    // Deferred so we control exactly when the ack resolves, mirroring the
    // real ~ms local-IPC round-trip send() races against.
    let resolveAck: (v: any) => void;
    const ack = new Promise((resolve) => { resolveAck = resolve; });
    (window as any).claude.native.send.mockReturnValue(ack);

    const onToast = vi.fn();
    render(
      <ChatProvider>
        <SkillProvider>
          <InputBar sessionId="sess-1" provider="native" onToast={onToast} />
        </SkillProvider>
      </ChatProvider>,
    );

    const textarea = screen.getByPlaceholderText('Message Claude...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello world' } });
    expect(textarea.value).toBe('hello world');

    const sendButton = screen.getByRole('button', { name: 'Send message' });
    fireEvent.click(sendButton);

    // send() runs synchronously: sendMessage returns true immediately (before
    // the ack settles) so the textarea clears right away, same as every other
    // provider path — this is the observable BEFORE the fix.
    expect(textarea.value).toBe('');

    // Now the ack resolves 'failed' — the bug: without the fix the draft
    // stays lost. With the fix, the failure branch refills it.
    resolveAck!({ status: 'failed', reason: 'not-live' });

    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(
        'This session is no longer running. Start or resume it to send messages.',
      );
    });
    await waitFor(() => {
      expect(textarea.value).toBe('hello world');
    });
  });

  it('does NOT clobber newer text the user typed during the ack round-trip', async () => {
    let resolveAck: (v: any) => void;
    const ack = new Promise((resolve) => { resolveAck = resolve; });
    (window as any).claude.native.send.mockReturnValue(ack);

    const onToast = vi.fn();
    render(
      <ChatProvider>
        <SkillProvider>
          <InputBar sessionId="sess-1" provider="native" onToast={onToast} />
        </SkillProvider>
      </ChatProvider>,
    );

    const textarea = screen.getByPlaceholderText('Message Claude...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'first message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(textarea.value).toBe('');

    // User starts typing a NEW message while the first send's ack is still in flight.
    fireEvent.change(textarea, { target: { value: 'second draft' } });

    resolveAck!({ status: 'failed', reason: 'queue-full' });

    await waitFor(() => {
      expect(onToast).toHaveBeenCalled();
    });
    // The guard (`cur.trim() ? cur : ...`) must have refused to overwrite —
    // the newer draft survives, the lost first message does not reappear.
    expect(textarea.value).toBe('second draft');
  });

  it('restores the draft and shows a toast when the invoke REJECTS (final-review fix)', async () => {
    // Unlike the two tests above (a resolved 'failed'/undefined ack), this
    // covers the IPC hop itself throwing — version skew or a dropped remote
    // WebSocket. Before the fix this was an unhandled rejection: no toast,
    // draft silently gone.
    let rejectAck: (err: unknown) => void;
    const ack = new Promise((_resolve, reject) => { rejectAck = reject; });
    (window as any).claude.native.send.mockReturnValue(ack);

    const onToast = vi.fn();
    render(
      <ChatProvider>
        <SkillProvider>
          <InputBar sessionId="sess-1" provider="native" onToast={onToast} />
        </SkillProvider>
      </ChatProvider>,
    );

    const textarea = screen.getByPlaceholderText('Message Claude...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello world' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(textarea.value).toBe('');

    rejectAck!(new Error('invoke rejected'));

    // Falls back to the same undefined-result copy as the other failure branch.
    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(
        'The message could not be sent — no response from the session host.',
      );
    });
    await waitFor(() => {
      expect(textarea.value).toBe('hello world');
    });
  });
});
