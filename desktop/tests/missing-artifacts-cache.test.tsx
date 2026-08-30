// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useMissingArtifacts,
  refreshMissingArtifacts,
  __resetMissingArtifactsCache,
} from '../src/renderer/hooks/useMissingArtifacts';

// The "deleted files flash": the Session Drawer used to hold the on-disk
// verdict in component-local state that reset to EMPTY on every close, so each
// open painted the full list and then removed rows one IPC round trip later.
// These cases pin the two properties that make that impossible — knowledge
// outlives the component, and it is never cleared before its replacement
// arrives. Regressing either one brings the flash back.

const ROOT = '/proj';

function installBridge(impl: (root: string, ids: string[]) => Promise<any>) {
  (globalThis as any).window.claude = { artifacts: { checkExistence: vi.fn(impl) } };
  return (globalThis as any).window.claude.artifacts.checkExistence;
}

beforeEach(() => {
  __resetMissingArtifactsCache();
  delete (globalThis as any).window.claude;
});

describe('useMissingArtifacts', () => {
  it('reports not-known until the first check settles, then the verdict', async () => {
    installBridge(async () => ({ ok: true, missingIds: ['b'] }));
    const { result } = renderHook(() => useMissingArtifacts(ROOT, ['a', 'b']));
    expect(result.current.known).toBe(false);       // the drawer holds its list here
    await waitFor(() => expect(result.current.known).toBe(true));
    expect([...result.current.missingIds]).toEqual(['b']);
  });

  it('a second consumer sees the cached verdict on its FIRST render', async () => {
    installBridge(async () => ({ ok: true, missingIds: ['b'] }));
    const first = renderHook(() => useMissingArtifacts(ROOT, ['a', 'b']));
    await waitFor(() => expect(first.result.current.known).toBe(true));
    first.unmount();   // the drawer closing must not discard what was learned

    // This is the drawer opening: no effect has run yet for this consumer, and
    // the answer is already right. That is the whole fix.
    const second = renderHook(() => useMissingArtifacts(ROOT, ['a', 'b']));
    expect(second.result.current.known).toBe(true);
    expect(second.result.current.missingIds.has('b')).toBe(true);
  });

  it('never blanks the verdict while a refresh is in flight', async () => {
    let release: (v: any) => void = () => {};
    installBridge(() => new Promise((r) => { release = r; }));
    const { result } = renderHook(() => useMissingArtifacts(ROOT, ['a', 'b']));
    act(() => { release({ ok: true, missingIds: ['b'] }); });
    await waitFor(() => expect(result.current.known).toBe(true));

    // A slow second check must leave the previous answer standing — an
    // optimistic reset to "everything is present" IS the flash.
    installBridge(() => new Promise((r) => { release = r; }));
    act(() => { void refreshMissingArtifacts(ROOT, ['a', 'b', 'c']); });
    expect(result.current.missingIds.has('b')).toBe(true);
    await act(async () => { release({ ok: true, missingIds: ['c'] }); });
    await waitFor(() => expect(result.current.missingIds.has('c')).toBe(true));
    expect(result.current.missingIds.has('b')).toBe(false);
  });

  it('keeps verdicts for ids the latest check did not ask about', async () => {
    installBridge(async (_root, ids) => ({ ok: true, missingIds: ids.filter((i) => i === 'b') }));
    const { result } = renderHook(() => useMissingArtifacts(ROOT, ['a', 'b']));
    await waitFor(() => expect(result.current.missingIds.has('b')).toBe(true));
    // The badge checks a narrower id set than the drawer; neither may erase
    // what the other established.
    await act(async () => { await refreshMissingArtifacts(ROOT, ['a']); });
    expect(result.current.missingIds.has('b')).toBe(true);
  });

  it('settles even when the surface cannot answer, so the list never hangs blank', async () => {
    installBridge(async () => ({ ok: false, error: 'not-implemented-on-mobile' }));
    const { result } = renderHook(() => useMissingArtifacts(ROOT, ['a']));
    await waitFor(() => expect(result.current.known).toBe(true));
    expect(result.current.missingIds.size).toBe(0);
  });

  it('shares one answer between two spellings of the same folder', async () => {
    // The header badge and the drawer can be handed the same directory spelled
    // differently (a trailing slash, a Windows drive letter cased either way);
    // if they keyed separately, the second one to mount would start cold and
    // flash. The IPC call still gets the caller's own spelling.
    installBridge(async () => ({ ok: true, missingIds: ['b'] }));
    const first = renderHook(() => useMissingArtifacts('/proj/', ['a', 'b']));
    await waitFor(() => expect(first.result.current.known).toBe(true));
    const second = renderHook(() => useMissingArtifacts('/proj', ['a', 'b']));
    expect(second.result.current.known).toBe(true);
    expect(second.result.current.missingIds.has('b')).toBe(true);
  });

  it('coalesces an identical in-flight request instead of re-asking', async () => {
    const spy = installBridge(async () => ({ ok: true, missingIds: [] }));
    await act(async () => {
      await Promise.all([
        refreshMissingArtifacts(ROOT, ['a', 'b']),
        refreshMissingArtifacts(ROOT, ['a', 'b']),
      ]);
    });
    expect(spy.mock.calls.length).toBe(1);
  });
});
