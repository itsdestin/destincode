// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ChatProvider, useChatDispatch } from '../state/chat-context';
import { useActiveSessionModel } from './useActiveSessionModel';

function Providers({ children }: { children: React.ReactNode }) {
  return <ChatProvider>{children}</ChatProvider>;
}

// Drives the active sessionId from a ref the test flips, so we can exercise the
// switch path (sessionId change with no accompanying dispatch).
function useHarness(getSid: () => string | null) {
  const dispatch = useChatDispatch();
  const model = useActiveSessionModel(getSid());
  return { dispatch, model };
}

// A real TRANSCRIPT_ASSISTANT_TEXT with `model` stamps the turn's model —
// verified against chat-types.ts:348-356 and the reducer (turn.model =
// action.model). This is exactly how the app populates it in production.
function seedTurn(dispatch: (a: any) => void, sessionId: string, model: string, uuid: string) {
  act(() => {
    dispatch({ type: 'SESSION_INIT', sessionId });
    dispatch({ type: 'TRANSCRIPT_USER_MESSAGE', sessionId, uuid: `${uuid}-u`, text: 'hi', timestamp: 1 });
    dispatch({ type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId, uuid: `${uuid}-a`, text: 'ok', timestamp: 2, model });
  });
}

describe('useActiveSessionModel', () => {
  it('returns null with no session or no assistant turns', () => {
    let sid: string | null = null;
    const { result, rerender } = renderHook(() => useHarness(() => sid), { wrapper: Providers });
    expect(result.current.model).toBe(null);
    // Session inited but no assistant turn yet → still null.
    act(() => { result.current.dispatch({ type: 'SESSION_INIT', sessionId: 's1' }); });
    sid = 's1'; rerender();
    expect(result.current.model).toBe(null);
  });

  it('returns the alias of the active session\'s latest known model', () => {
    let sid: string | null = 's1';
    const { result } = renderHook(() => useHarness(() => sid), { wrapper: Providers });
    seedTurn(result.current.dispatch, 's1', 'claude-opus-4-7', 'm1');
    expect(result.current.model).toBe('opus[1m]');
  });

  it('tracks a live model change on the active session (the transcript trigger)', () => {
    let sid: string | null = 's1';
    const { result } = renderHook(() => useHarness(() => sid), { wrapper: Providers });
    seedTurn(result.current.dispatch, 's1', 'claude-sonnet-4-5', 'm1');
    expect(result.current.model).toBe('sonnet');
    // A later turn on a different model (e.g. auto-downshift) → alias updates.
    act(() => {
      result.current.dispatch({ type: 'TRANSCRIPT_USER_MESSAGE', sessionId: 's1', uuid: 'm2-u', text: 'more', timestamp: 3 });
      result.current.dispatch({ type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: 's1', uuid: 'm2-a', text: 'ok', timestamp: 4, model: 'claude-haiku-4-5' });
    });
    expect(result.current.model).toBe('haiku');
  });

  it('recomputes for the new session on switch WITH NO dispatch (the switch trigger)', () => {
    // This is the whole reason option (c) exists: switching into a
    // background-drifted idle session must reconcile its pill.
    let sid: string | null = 's1';
    const { result, rerender } = renderHook(() => useHarness(() => sid), { wrapper: Providers });
    seedTurn(result.current.dispatch, 's1', 'claude-opus-4-7', 'm1');
    seedTurn(result.current.dispatch, 's2', 'claude-haiku-4-5', 'm2');
    expect(result.current.model).toBe('opus[1m]');   // active = s1
    // Switch to s2 — a pure sessionId change, NO chat dispatch.
    sid = 's2'; rerender();
    expect(result.current.model).toBe('haiku');      // recomputed for s2
  });

  it('looks past a <synthetic> turn to the real model behind it', () => {
    // Regression (2026-08-26): CC stamps `<synthetic>` on assistant turns IT
    // composed — "You've hit your session limit", "You're out of usage
    // credits", "Please run /login". Those are the LAST turn precisely when you
    // hit a limit, so stopping on one returned null, and AppInner's
    // drift-reconciliation effect bails on null — leaving a pill stuck on the
    // red 'unknown' sentinel instead of self-healing.
    let sid: string | null = 's1';
    const { result } = renderHook(() => useHarness(() => sid), { wrapper: Providers });
    seedTurn(result.current.dispatch, 's1', 'claude-opus-5', 'm1');
    act(() => {
      result.current.dispatch({ type: 'TRANSCRIPT_USER_MESSAGE', sessionId: 's1', uuid: 'm2-u', text: 'more', timestamp: 3 });
      result.current.dispatch({ type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: 's1', uuid: 'm2-a', text: "You've hit your session limit", timestamp: 4, model: '<synthetic>' });
    });
    expect(result.current.model).toBe('opus[1m]');
  });

  it('returns null when EVERY turn is <synthetic>', () => {
    // A session that hit the limit on its first turn ran no model at all. Null
    // is the honest answer — the pill keeps whatever it had rather than being
    // reconciled to a guess.
    let sid: string | null = 's1';
    const { result } = renderHook(() => useHarness(() => sid), { wrapper: Providers });
    seedTurn(result.current.dispatch, 's1', '<synthetic>', 'm1');
    expect(result.current.model).toBe(null);
  });

  it('returns null for an unrecognized model string', () => {
    let sid: string | null = 's1';
    const { result } = renderHook(() => useHarness(() => sid), { wrapper: Providers });
    seedTurn(result.current.dispatch, 's1', 'gpt-4-turbo', 'm1');
    expect(result.current.model).toBe(null);
  });
});
