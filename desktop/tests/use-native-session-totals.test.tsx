// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNativeSessionTotals } from '../src/renderer/hooks/useNativeSessionTotals';

// Mirrors the harness the sibling useNativeSessionUsage test uses — see that
// file for the store/provider wrapper if this one drifts.
import { makeStoreWrapper, dispatchTo } from './helpers/chat-store-harness';

describe('useNativeSessionTotals', () => {
  it('returns null for a session that does not exist', () => {
    const { wrapper } = makeStoreWrapper();
    const { result } = renderHook(() => useNativeSessionTotals('nope'), { wrapper });
    expect(result.current).toBeNull();
  });

  it('returns the same object reference until a total actually changes', () => {
    const { wrapper, store } = makeStoreWrapper(['s1']);
    const { result } = renderHook(() => useNativeSessionTotals('s1'), { wrapper });
    const first = result.current;
    act(() => { dispatchTo(store, { type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: 's1' } as any); });
    expect(result.current).toBe(first);   // stable snapshot — React loops otherwise
  });

  it('updates when a turn completes', () => {
    const { wrapper, store } = makeStoreWrapper(['s1']);
    const { result } = renderHook(() => useNativeSessionTotals('s1'), { wrapper });
    act(() => {
      dispatchTo(store, {
        type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: 's1', uuid: 'u1', timestamp: 1,
        stopReason: 'end_turn', model: 'm', anthropicRequestId: null,
        usage: { inputTokens: 42, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0 },
      } as any);
    });
    expect(result.current?.inputTokens).toBe(42);
  });
});
