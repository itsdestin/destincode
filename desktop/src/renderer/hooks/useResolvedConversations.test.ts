// @vitest-environment jsdom
//
// SessionDrawer's preview header calls this hook UNCONDITIONALLY (rules of
// hooks — it sits above an early return), passing `[]` whenever nothing is
// previewed. Before the 2026-08-26 fix that still round-tripped
// `chatsearch.resolve([])` on every idle drawer render; this pins that an
// empty id list makes zero calls, with the non-empty case as the positive
// control so the bail can't be mistaken for the hook just not calling out at all.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { useResolvedConversations } from './useResolvedConversations';

afterEach(() => { cleanup(); delete (window as any).claude; });

describe('useResolvedConversations', () => {
  it('makes no chatsearch:resolve call for an empty id list, and settles non-loading immediately', () => {
    const resolve = vi.fn().mockResolvedValue({ ok: true, results: [] });
    (window as any).claude = { chatsearch: { resolve } };
    const { result } = renderHook(() => useResolvedConversations([]));
    expect(result.current).toEqual({ results: [], loading: false, unavailable: false });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('resolves a non-empty id list — positive control for the empty-list bail above', async () => {
    const resolve = vi.fn().mockResolvedValue({
      ok: true,
      results: [{ status: 'unknown', query: 'abc' }],
    });
    (window as any).claude = { chatsearch: { resolve } };
    const { result } = renderHook(() => useResolvedConversations(['abc']));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(resolve).toHaveBeenCalledWith(['abc']);
    expect(result.current.results).toEqual([{ status: 'unknown', query: 'abc' }]);
  });

  it('going from a non-empty list back to [] makes no further calls and clears to the empty state', async () => {
    const resolve = vi.fn().mockResolvedValue({ ok: true, results: [{ status: 'unknown', query: 'abc' }] });
    (window as any).claude = { chatsearch: { resolve } };
    const { result, rerender } = renderHook(({ ids }) => useResolvedConversations(ids), {
      initialProps: { ids: ['abc'] },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(resolve).toHaveBeenCalledTimes(1);

    rerender({ ids: [] });
    expect(result.current).toEqual({ results: [], loading: false, unavailable: false });
    expect(resolve).toHaveBeenCalledTimes(1); // still one — the [] rerender made no new call
  });
});
