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

  // Fix (I2, whole-branch review 2026-08-16). This case used to assert the
  // OPPOSITE — that any non-'ok' state hid the Stop button. That was only ever
  // right because 'stuck' was unreachable for a native session; the stall work
  // made it the stage-1 warning state, so the assertion started describing a
  // regression instead of a rule. A warned turn is still generating.
  it('STAYS true through the stall warning (stuck) — the turn is still running', () => {
    const { result } = renderHook(useHarness, { wrapper: Providers });
    act(() => { result.current.dispatch({ type: 'SESSION_INIT', sessionId: 's1' }); });
    act(() => {
      result.current.dispatch({ type: 'USER_PROMPT', sessionId: 's1', content: 'hi', timestamp: 1 });
    });
    act(() => {
      result.current.dispatch({
        type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: 's1',
        stallWarning: { retryInMs: 15_000, willRetry: false },
      });
    });
    expect(result.current.gate).toBe(true);
  });

  // The parked card carries its own Stop, but the composer's must ALSO stay —
  // it is the control a phone user (no ESC key) already knows where to find,
  // and the card can be scrolled off screen while the composer never is.
  it('STAYS true while the turn is parked (stalled)', () => {
    const { result } = renderHook(useHarness, { wrapper: Providers });
    act(() => { result.current.dispatch({ type: 'SESSION_INIT', sessionId: 's1' }); });
    act(() => {
      result.current.dispatch({ type: 'USER_PROMPT', sessionId: 's1', content: 'hi', timestamp: 1 });
    });
    act(() => {
      result.current.dispatch({
        type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: 's1', stalled: true,
      });
    });
    expect(result.current.gate).toBe(true);
  });

  // The CLAUDE CODE input path (F2, 2026-08-16). The two cases above drive
  // 'stuck' through the native harness heartbeat; this one drives it the way
  // the PTY buffer classifier does — a bare ATTENTION_STATE_CHANGED, which is
  // the ONLY way a Claude Code session reaches 'stuck'. Master asserted the
  // opposite here (button hidden) and this branch replaced the case rather
  // than re-pointing it, which left CC behaviour pinned in neither direction.
  //
  // This pins the NEW intended behaviour: a stuck CC turn KEEPS the Stop
  // button. Deliberate — a stuck CC session was un-stoppable for a phone user
  // with no ESC key, the same defect the native fix closes, and the click just
  // writes one ESC byte to the PTY (see useStreamingGate.ts).
  it('STAYS true when the PTY classifier flags a Claude Code session stuck', () => {
    const { result } = renderHook(useHarness, { wrapper: Providers });
    act(() => { result.current.dispatch({ type: 'SESSION_INIT', sessionId: 's1' }); });
    act(() => {
      result.current.dispatch({ type: 'USER_PROMPT', sessionId: 's1', content: 'hi', timestamp: 1 });
    });
    act(() => {
      result.current.dispatch({ type: 'ATTENTION_STATE_CHANGED', sessionId: 's1', state: 'stuck' });
    });
    expect(result.current.gate).toBe(true);
  });

  // The other half of the CC input path: the classifier clearing back to 'ok'
  // must not disturb the gate either. Pinned so a future "fix" that special-
  // cases the classifier's dispatch can't silently flip only one direction.
  it('STAYS true when the PTY classifier clears a Claude Code session back to ok', () => {
    const { result } = renderHook(useHarness, { wrapper: Providers });
    act(() => { result.current.dispatch({ type: 'SESSION_INIT', sessionId: 's1' }); });
    act(() => {
      result.current.dispatch({ type: 'USER_PROMPT', sessionId: 's1', content: 'hi', timestamp: 1 });
    });
    act(() => {
      result.current.dispatch({ type: 'ATTENTION_STATE_CHANGED', sessionId: 's1', state: 'stuck' });
    });
    act(() => {
      result.current.dispatch({ type: 'ATTENTION_STATE_CHANGED', sessionId: 's1', state: 'ok' });
    });
    expect(result.current.gate).toBe(true);
  });

  // Unchanged behavior, pinned so the exclusion list can't be emptied by
  // accident: a turn that has ENDED has nothing left to stop.
  it('is false once the provider errors — the turn is over', () => {
    const { result } = renderHook(useHarness, { wrapper: Providers });
    act(() => { result.current.dispatch({ type: 'SESSION_INIT', sessionId: 's1' }); });
    act(() => {
      result.current.dispatch({ type: 'USER_PROMPT', sessionId: 's1', content: 'hi', timestamp: 1 });
    });
    act(() => {
      result.current.dispatch({ type: 'NATIVE_SESSION_ERROR', sessionId: 's1', message: 'boom' });
    });
    expect(result.current.gate).toBe(false);
  });

  it('is false once the session process exits — the turn is over', () => {
    const { result } = renderHook(useHarness, { wrapper: Providers });
    act(() => { result.current.dispatch({ type: 'SESSION_INIT', sessionId: 's1' }); });
    act(() => {
      result.current.dispatch({ type: 'USER_PROMPT', sessionId: 's1', content: 'hi', timestamp: 1 });
    });
    act(() => {
      result.current.dispatch({ type: 'SESSION_PROCESS_EXITED', sessionId: 's1', exitCode: 1 });
    });
    expect(result.current.gate).toBe(false);
  });
});
