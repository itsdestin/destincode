// @vitest-environment jsdom
//
// Focused unit test for the hook InputBar's stop-button gate now reads
// (review finding, 2026-07-22, Task 10 follow-up) instead of the full
// useChatState(sessionId) snapshot. Mirrors useSessionAttention.test.tsx's
// renderHook + dispatch idiom. Re-render-skip itself isn't asserted here
// (would need a commit counter, see selector-rerender.test.tsx) — the boolean
// primitive return already gets that behavior for free from
// useSyncExternalStore's Object.is check, and the review only asked for
// correctness coverage across the transitions InputBar's own tests drive.
import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ChatProvider, useChatDispatch } from '../state/chat-context';
import { useStreamingGate } from './useStreamingGate';

function Providers({ children }: { children: React.ReactNode }) {
  return <ChatProvider>{children}</ChatProvider>;
}

function useHarness() {
  const dispatch = useChatDispatch();
  const gate = useStreamingGate('s1');
  return { dispatch, gate };
}

describe('useStreamingGate', () => {
  it('is false for a session with no chat state', () => {
    const { result } = renderHook(useHarness, { wrapper: Providers });
    expect(result.current.gate).toBe(false);
  });

  it('is false for a freshly inited, idle session', () => {
    const { result } = renderHook(useHarness, { wrapper: Providers });
    act(() => { result.current.dispatch({ type: 'SESSION_INIT', sessionId: 's1' }); });
    expect(result.current.gate).toBe(false);
  });

  it('flips true once the session starts thinking (USER_PROMPT sets isThinking + attentionState ok)', () => {
    const { result } = renderHook(useHarness, { wrapper: Providers });
    act(() => { result.current.dispatch({ type: 'SESSION_INIT', sessionId: 's1' }); });
    act(() => {
      result.current.dispatch({ type: 'USER_PROMPT', sessionId: 's1', content: 'hi', timestamp: 1 });
    });
    expect(result.current.gate).toBe(true);
  });

  it('flips back false when attentionState leaves ok, even while still thinking', () => {
    const { result } = renderHook(useHarness, { wrapper: Providers });
    act(() => { result.current.dispatch({ type: 'SESSION_INIT', sessionId: 's1' }); });
    act(() => {
      result.current.dispatch({ type: 'USER_PROMPT', sessionId: 's1', content: 'hi', timestamp: 1 });
    });
    act(() => {
      result.current.dispatch({ type: 'ATTENTION_STATE_CHANGED', sessionId: 's1', state: 'stuck' });
    });
    expect(result.current.gate).toBe(false);
  });
});
