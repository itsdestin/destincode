// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ChatProvider, useChatDispatch } from '../state/chat-context';
import { useSessionAttention } from './useSessionAttention';

const SESSIONS = [{ id: 's1' }, { id: 's2' }];

function Providers({ children }: { children: React.ReactNode }) {
  return <ChatProvider>{children}</ChatProvider>;
}

// viewedSessions/activeSessionId are fixed for these cases; the hook mirrors
// them into a ref, so passing new identities per render is not under test here.
function useHarness() {
  const dispatch = useChatDispatch();
  const attention = useSessionAttention(SESSIONS, new Set<string>(['s1']), 's1');
  return { dispatch, attention };
}

describe('useSessionAttention', () => {
  it('returns gray for a session with no chat state and for a freshly inited one', () => {
    const { result } = renderHook(useHarness, { wrapper: Providers });
    expect(result.current.attention.get('s1')?.status).toBe('gray');
    act(() => { result.current.dispatch({ type: 'SESSION_INIT', sessionId: 's1' }); });
    expect(result.current.attention.get('s1')?.status).toBe('gray');
    expect(result.current.attention.get('s1')?.attentionState).toBe('ok');
    expect(result.current.attention.get('s1')?.awaitingApproval).toBe(false);
  });

  it('flips to green when a session starts thinking (USER_PROMPT sets isThinking)', () => {
    const { result } = renderHook(useHarness, { wrapper: Providers });
    act(() => { result.current.dispatch({ type: 'SESSION_INIT', sessionId: 's1' }); });
    act(() => {
      result.current.dispatch({
        type: 'USER_PROMPT', sessionId: 's1', content: 'hi', timestamp: 1,
      });
    });
    expect(result.current.attention.get('s1')?.status).toBe('green');
  });

  it('flips to red + awaitingApproval when a permission request lands', () => {
    const { result } = renderHook(useHarness, { wrapper: Providers });
    act(() => { result.current.dispatch({ type: 'SESSION_INIT', sessionId: 's1' }); });
    act(() => {
      result.current.dispatch({
        type: 'PERMISSION_REQUEST', sessionId: 's1', toolName: 'Bash',
        input: { command: 'ls' }, requestId: 'req-1',
      });
    });
    expect(result.current.attention.get('s1')?.status).toBe('red');
    expect(result.current.attention.get('s1')?.awaitingApproval).toBe(true);
  });

  it('keeps Map IDENTITY stable when a dispatch changes no triple (the perf contract)', () => {
    const { result } = renderHook(useHarness, { wrapper: Providers });
    act(() => { result.current.dispatch({ type: 'SESSION_INIT', sessionId: 's1' }); });
    act(() => {
      result.current.dispatch({
        type: 'USER_PROMPT', sessionId: 's1', content: 'first', timestamp: 1,
      });
    });
    const afterThinking = result.current.attention;
    expect(afterThinking.get('s1')?.status).toBe('green');
    // Second prompt while ALREADY thinking: timeline grows, isThinking stays
    // true → no triple changes → the selector must return the SAME Map object.
    act(() => {
      result.current.dispatch({
        type: 'USER_PROMPT', sessionId: 's1', content: 'second', timestamp: 2,
      });
    });
    expect(result.current.attention).toBe(afterThinking);
  });

  it('changes identity when a triple actually changes', () => {
    const { result } = renderHook(useHarness, { wrapper: Providers });
    act(() => { result.current.dispatch({ type: 'SESSION_INIT', sessionId: 's1' }); });
    const before = result.current.attention;
    act(() => {
      result.current.dispatch({
        type: 'USER_PROMPT', sessionId: 's1', content: 'go', timestamp: 1,
      });
    });
    expect(result.current.attention).not.toBe(before);   // gray → green
  });
});
