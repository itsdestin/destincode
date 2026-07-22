// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { ChatProvider, useChatDispatch } from '../state/chat-context';
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

// Task 10: dispatch-capture idiom mirrored from selector-rerender.test.tsx —
// InputBar now reads chat state via useChatState(sessionId) for the stop
// button, so these tests need to drive the REAL store through the reducer
// (USER_PROMPT sets isThinking:true + attentionState:'ok'; ATTENTION_STATE_
// CHANGED flips attentionState alone) rather than mocking state directly —
// per the react-renderer rule, useChatState is the only approved render-path
// read, so exercising it through real dispatches is the honest way to cover
// the visibility predicate.
let capturedDispatch: ((a: any) => void) | null = null;
function DispatchCapture() {
  capturedDispatch = useChatDispatch();
  return null;
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

// Task 10 (Destin placement ruling): the stop control moved from beside the
// ThinkingIndicator in ChatView into the composer row, immediately left of
// the send button. Same visibility gate (isThinking && attentionState ===
// 'ok'), same click behavior as StopButton.test.tsx — those cases aren't
// re-tested here (StopButton itself is unchanged), only that InputBar wires
// the real predicate off useChatState(sessionId) and renders it in this row.
describe('InputBar — stop button (Task 10 placement)', () => {
  beforeEach(() => {
    (global as any).ResizeObserver = NoopResizeObserver;
    capturedDispatch = null;
    (window as any).claude = {
      native: {
        supported: true,
        send: vi.fn(),
        interrupt: vi.fn(),
      },
      session: {
        sendInput: vi.fn(),
      },
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

  function renderInputBar(provider: 'claude' | 'native' = 'claude') {
    render(
      <ChatProvider>
        <SkillProvider>
          <DispatchCapture />
          <InputBar sessionId="sess-1" provider={provider} />
        </SkillProvider>
      </ChatProvider>,
    );
  }

  it('hides the stop button while the session is idle', () => {
    renderInputBar();
    expect(screen.queryByRole('button', { name: 'Stop generating' })).not.toBeInTheDocument();
  });

  it('shows the stop button once the session starts thinking with ok attention', () => {
    renderInputBar();
    // SESSION_INIT first — USER_PROMPT is a no-op against a session absent
    // from the map (mirrors useSessionAttention.test.tsx's seeding idiom).
    act(() => { capturedDispatch!({ type: 'SESSION_INIT', sessionId: 'sess-1' }); });
    act(() => {
      capturedDispatch!({ type: 'USER_PROMPT', sessionId: 'sess-1', content: 'hi', timestamp: 1 });
    });
    expect(screen.getByRole('button', { name: 'Stop generating' })).toBeInTheDocument();
  });

  it('hides the stop button when attentionState is not ok, even while thinking', () => {
    renderInputBar();
    act(() => { capturedDispatch!({ type: 'SESSION_INIT', sessionId: 'sess-1' }); });
    act(() => {
      capturedDispatch!({ type: 'USER_PROMPT', sessionId: 'sess-1', content: 'hi', timestamp: 1 });
    });
    act(() => {
      capturedDispatch!({ type: 'ATTENTION_STATE_CHANGED', sessionId: 'sess-1', state: 'stuck' });
    });
    expect(screen.queryByRole('button', { name: 'Stop generating' })).not.toBeInTheDocument();
  });

  it('provider="native": click calls native.interrupt, never session.sendInput', () => {
    renderInputBar('native');
    act(() => { capturedDispatch!({ type: 'SESSION_INIT', sessionId: 'sess-1' }); });
    act(() => {
      capturedDispatch!({ type: 'USER_PROMPT', sessionId: 'sess-1', content: 'hi', timestamp: 1 });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }));
    expect((window as any).claude.native.interrupt).toHaveBeenCalledWith('sess-1');
    expect((window as any).claude.session.sendInput).not.toHaveBeenCalled();
  });

  it('provider="claude": click sends a single ESC byte via session.sendInput', () => {
    renderInputBar('claude');
    act(() => { capturedDispatch!({ type: 'SESSION_INIT', sessionId: 'sess-1' }); });
    act(() => {
      capturedDispatch!({ type: 'USER_PROMPT', sessionId: 'sess-1', content: 'hi', timestamp: 1 });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }));
    expect((window as any).claude.session.sendInput).toHaveBeenCalledWith('sess-1', '\x1b');
    expect((window as any).claude.native.interrupt).not.toHaveBeenCalled();
  });
});
