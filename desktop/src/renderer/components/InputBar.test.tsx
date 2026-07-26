// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { ChatProvider, useChatDispatch, useChatStore } from '../state/chat-context';
import { SkillProvider } from '../state/skill-context';
// Task 4: InputBar now calls useReference() unconditionally (placeholder +
// send-time scaffold assembly), which throws outside a ReferenceProvider —
// every render site below needs the wrapper, same sessionId as the InputBar
// under test (App.tsx scopes ReferenceProvider by sessionId the same way).
// useReference/PendingReference are additionally needed by the gap-1/gap-2
// regression tests below, which read/set the held reference directly via a
// Probe component (same idiom as InputBar.reference.test.tsx).
import { ReferenceProvider, useReference, type PendingReference } from '../state/reference-context';
import InputBar, { InputBarHandle } from './InputBar';

// Hoisted to module scope (mirrors InputBar.reference.test.tsx's Probe idiom):
// tsc's definite-assignment check only exempts USAGE inside a nested closure
// relative to the declaration — a local `let api` inside an `it(...)` body
// with a direct `expect(api...)` in the same scope still trips TS2454, even
// though render() has synchronously run Probe by then. Module scope makes
// every usage (inside a nested `it()` closure) exempt.
let referenceApi: ReturnType<typeof useReference>;
function ReferenceProbe() { referenceApi = useReference(); return null; }

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
          <ReferenceProvider sessionId="sess-1">
            <InputBar sessionId="sess-1" provider="native" onToast={onToast} />
          </ReferenceProvider>
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
          <ReferenceProvider sessionId="sess-1">
            <InputBar sessionId="sess-1" provider="native" onToast={onToast} />
          </ReferenceProvider>
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
          <ReferenceProvider sessionId="sess-1">
            <InputBar sessionId="sess-1" provider="native" onToast={onToast} />
          </ReferenceProvider>
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

// Gap 1 (task-4-report.md "Concerns" #1): a failed async native send restores
// the draft (tested above) but, before this fix, silently dropped the held
// reference — clearReference() already ran synchronously in send() right
// after the optimistic sendMessage() returned true, before the ack settled.
// The user got their text back with the "Ask Claude about X" scaffold gone,
// and resending would have silently omitted it.
describe('InputBar native send — failure also restores the held reference (gap 1 fix)', () => {
  const REF: PendingReference = {
    kind: 'chat-text',
    label: '"earlier text"',
    promptText: 'In an earlier message, you said:\n"x"\n\nThe user has a follow-up: ',
    anchor: null,
  };

  beforeEach(() => {
    (global as any).ResizeObserver = NoopResizeObserver;
    (window as any).claude = {
      native: {
        supported: true,
        send: vi.fn(),
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

  it('restores the reference alongside the draft when the ack is failed', async () => {
    let resolveAck: (v: any) => void;
    const ack = new Promise((resolve) => { resolveAck = resolve; });
    (window as any).claude.native.send.mockReturnValue(ack);

    const onToast = vi.fn();
    render(
      <ChatProvider>
        <SkillProvider>
          <ReferenceProvider sessionId="sess-1">
            <ReferenceProbe />
            <InputBar sessionId="sess-1" provider="native" onToast={onToast} />
          </ReferenceProvider>
        </SkillProvider>
      </ChatProvider>,
    );

    act(() => { referenceApi.setReference(REF); });
    const textarea = screen.getByPlaceholderText('Ask Claude about "earlier text"') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello world' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    // send() clears the reference synchronously on the optimistic path —
    // this is correct and unchanged (spec §7's success-path clear).
    expect(referenceApi.reference).toBeNull();
    expect(textarea.value).toBe('');

    resolveAck!({ status: 'failed', reason: 'not-live' });

    await waitFor(() => {
      expect(onToast).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(textarea.value).toBe('hello world');
    });
    // The fix: the reference travels back with the draft instead of staying
    // gone. Without it, this stays null and the test fails.
    expect(referenceApi.reference).toEqual(REF);
  });

  it('does NOT clobber a newer reference the user set during the ack round-trip', async () => {
    let resolveAck: (v: any) => void;
    const ack = new Promise((resolve) => { resolveAck = resolve; });
    (window as any).claude.native.send.mockReturnValue(ack);

    const onToast = vi.fn();
    render(
      <ChatProvider>
        <SkillProvider>
          <ReferenceProvider sessionId="sess-1">
            <ReferenceProbe />
            <InputBar sessionId="sess-1" provider="native" onToast={onToast} />
          </ReferenceProvider>
        </SkillProvider>
      </ChatProvider>,
    );

    act(() => { referenceApi.setReference(REF); });
    const textarea = screen.getByPlaceholderText('Ask Claude about "earlier text"') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'first message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(referenceApi.reference).toBeNull();

    // User picks a NEW reference while the first send's ack is still in flight.
    const REF2: PendingReference = { ...REF, label: '"newer text"' };
    act(() => { referenceApi.setReference(REF2); });

    resolveAck!({ status: 'failed', reason: 'queue-full' });

    await waitFor(() => {
      expect(onToast).toHaveBeenCalled();
    });
    // The guard (`cur ?? reference`) must have refused to overwrite — the
    // newer reference survives, the lost first reference does not reappear.
    expect(referenceApi.reference).toEqual(REF2);
  });
});

// Gap 2 (task-4-report.md "Concerns" #2): terminal view's send paths
// (handleSubmit's `minimal` branch, the textarea onKeyDown's `minimal`
// branch) write straight to the PTY and never call sendMessage/
// composeOutgoing, so a reference held in chat view would otherwise survive
// invisibly if the user switched to terminal view and sent from there — the
// scaffold is never sent AND the reference never clears. This suite covers
// the "clearing behavior" half (placeholderFor's silencing is covered by the
// pure-function test in InputBar.reference.test.tsx); driving an actual PTY
// send in jsdom isn't attempted here per the brief's guidance.
describe('InputBar — minimal (terminal) mode clears a held reference (gap 2 fix)', () => {
  const REF: PendingReference = {
    kind: 'chat-text',
    label: '"earlier text"',
    promptText: 'In an earlier message, you said:\n"x"\n\nThe user has a follow-up: ',
    anchor: null,
  };

  beforeEach(() => {
    (global as any).ResizeObserver = NoopResizeObserver;
    (window as any).claude = {
      native: { supported: true, send: vi.fn() },
      session: { sendInput: vi.fn() },
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

  it('clears a reference held from chat view when the composer switches into minimal mode', () => {
    const { rerender } = render(
      <ChatProvider>
        <SkillProvider>
          <ReferenceProvider sessionId="sess-1">
            <ReferenceProbe />
            <InputBar sessionId="sess-1" />
          </ReferenceProvider>
        </SkillProvider>
      </ChatProvider>,
    );

    act(() => { referenceApi.setReference(REF); });
    expect(referenceApi.reference).toEqual(REF);
    expect(screen.getByPlaceholderText('Ask Claude about "earlier text"')).toBeInTheDocument();

    // Same sessionId, same provider instances — only `minimal` flips, exactly
    // like the real chat-view -> terminal-view toggle (Ctrl+`).
    rerender(
      <ChatProvider>
        <SkillProvider>
          <ReferenceProvider sessionId="sess-1">
            <ReferenceProbe />
            <InputBar sessionId="sess-1" minimal />
          </ReferenceProvider>
        </SkillProvider>
      </ChatProvider>,
    );

    // Without the fix, this stays REF — nothing ever clears it, and the
    // "Ask Claude about ..." placeholder would keep promising a scaffold
    // that terminal view's send path can never deliver.
    expect(referenceApi.reference).toBeNull();
  });

  it('clears a reference set while the composer is already in minimal mode', () => {
    render(
      <ChatProvider>
        <SkillProvider>
          <ReferenceProvider sessionId="sess-1">
            <ReferenceProbe />
            <InputBar sessionId="sess-1" minimal />
          </ReferenceProvider>
        </SkillProvider>
      </ChatProvider>,
    );

    act(() => { referenceApi.setReference(REF); });

    // The effect's dep array includes `reference` (not just `minimal`), so it
    // re-fires on this set and clears it right back out rather than only
    // catching the chat-to-terminal transition.
    expect(referenceApi.reference).toBeNull();
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
          <ReferenceProvider sessionId="sess-1">
            <DispatchCapture />
            <InputBar sessionId="sess-1" provider={provider} />
          </ReferenceProvider>
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

// Task 11 (cancel/edit queued messages): the InputBarHandle ref idiom App uses
// for the Edit-refill flow — checked BEFORE removeQueued runs (hasDraft) and
// applied AFTER it succeeds (fillDraft). See InputBarHandle's WHY comment for
// why this extends the existing ref rather than introducing new App state.
describe('InputBar — InputBarHandle hasDraft/fillDraft (Task 11)', () => {
  beforeEach(() => {
    (global as any).ResizeObserver = NoopResizeObserver;
    (window as any).claude = {
      native: { supported: true, send: vi.fn() },
      session: { sendInput: vi.fn() },
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

  function renderWithRef() {
    const ref = React.createRef<InputBarHandle>();
    render(
      <ChatProvider>
        <SkillProvider>
          <ReferenceProvider sessionId="sess-1">
            <InputBar ref={ref} sessionId="sess-1" provider="native" />
          </ReferenceProvider>
        </SkillProvider>
      </ChatProvider>,
    );
    return ref;
  }

  it('hasDraft() is false on an empty composer', () => {
    const ref = renderWithRef();
    expect(ref.current!.hasDraft()).toBe(false);
  });

  it('hasDraft() is false for a whitespace-only draft (trimmed)', () => {
    const ref = renderWithRef();
    const textarea = screen.getByPlaceholderText('Message Claude...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '   ' } });
    expect(ref.current!.hasDraft()).toBe(false);
  });

  it('hasDraft() is true once the user has typed something', () => {
    const ref = renderWithRef();
    const textarea = screen.getByPlaceholderText('Message Claude...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'a draft in progress' } });
    expect(ref.current!.hasDraft()).toBe(true);
  });

  it('fillDraft() replaces the composer content and focuses it', () => {
    const ref = renderWithRef();
    const textarea = screen.getByPlaceholderText('Message Claude...') as HTMLTextAreaElement;
    act(() => { ref.current!.fillDraft('the edited queued message'); });
    expect(textarea.value).toBe('the edited queued message');
    expect(ref.current!.hasDraft()).toBe(true);
  });
});

// Task 12: a 'queued' native ack dispatches QUEUED_MESSAGE_ADDED (list entry,
// no timeline write) instead of a queued-flavored USER_PROMPT — see
// chat-reducer.ts and the Task 12 brief for why the old timeline bubble froze
// above content from the still-streaming prior turn.
describe('InputBar native send — queued ack dispatches QUEUED_MESSAGE_ADDED, not a timeline entry (Task 12)', () => {
  beforeEach(() => {
    (global as any).ResizeObserver = NoopResizeObserver;
    capturedDispatch = null;
    (window as any).claude = {
      native: { supported: true, send: vi.fn() },
      session: { sendInput: vi.fn() },
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

  it('dispatches QUEUED_MESSAGE_ADDED with the ack queueId, and writes NO timeline entry', async () => {
    (window as any).claude.native.send.mockResolvedValue({ status: 'queued', queueId: 'q-99' });

    let capturedStore: ReturnType<typeof useChatStore> | null = null;
    function StoreCapture() {
      capturedStore = useChatStore();
      return null;
    }

    render(
      <ChatProvider>
        <SkillProvider>
          <ReferenceProvider sessionId="sess-1">
            <DispatchCapture />
            <StoreCapture />
            <InputBar sessionId="sess-1" provider="native" />
          </ReferenceProvider>
        </SkillProvider>
      </ChatProvider>,
    );
    act(() => { capturedDispatch!({ type: 'SESSION_INIT', sessionId: 'sess-1' }); });

    const textarea = screen.getByPlaceholderText('Message Claude...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'queue me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => {
      const queued = capturedStore!.getState().get('sess-1')?.queuedMessages ?? [];
      expect(queued.length).toBe(1);
    });
    const session = capturedStore!.getState().get('sess-1')!;
    expect(session.timeline).toHaveLength(0);
    expect(session.queuedMessages).toEqual([
      { queueId: 'q-99', content: 'queue me', timestamp: expect.any(Number) },
    ]);
  });
});
