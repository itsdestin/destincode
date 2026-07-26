// @vitest-environment jsdom
// Fix: pin jsdom here because vitest.config.ts only auto-applies jsdom to
// tests under `tests/**/*.tsx`; this file lives under `src/**/*.test.ts`
// and would otherwise run in the default `node` env with no `window`.
//
// What's testable here vs. not: jsdom has no real layout engine, so every
// DOMRect it hands back (getBoundingClientRect) is zeroed and Range does not
// even implement getClientRects() at all (confirmed empirically against this
// repo's jsdom version) — there is no way to assert real pixel coordinates or
// spy through the prototype in this environment. What IS provable, and what
// these tests pin: (1) which CODE PATH the hook takes — range-in-host vs.
// containment-fallback vs. no-anchor — proven by stubbing an own-property
// getClientRects directly on the Range instance (spyOn can't wrap a method
// jsdom never defines) and checking which stub the hook actually called, and
// (2) that every listener + the ResizeObserver registered on mount is torn
// down on unmount. A real dev-instance visual check of the traced outline
// (does it actually wrap the selection, not the whole bubble) is still
// required before shipping — see the task report.
//
// IMPORTANT test-authoring gotcha hit while writing this file: passing
// `useReferenceGeometry(makeAnchor(host, range))` INLINE inside the
// `renderHook(() => ...)` callback creates a brand-new `anchor` object
// identity on every internal re-render. The hook's effect depends on
// `anchor` BY REFERENCE, and `measure()` always calls `setGeom({ ...new
// object... })` even when content is unchanged — so a fresh identity each
// render drove an unbounded render loop (reproduced as a multi-GB OOM, not a
// hang) that has nothing to do with the hook's real behavior: production
// `anchor` comes from stable context state. Every anchor below is therefore
// constructed ONCE, outside the renderHook callback.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useReferenceGeometry } from './use-reference-geometry';
import type { ReferenceAnchor } from '../../state/reference-context';

// jsdom doesn't implement ResizeObserver (same stub as InputBar.test.tsx /
// PreferencesPopup.test.tsx). Spy-able here (not a bare no-op) because the
// cleanup test needs to prove disconnect() actually fires on unmount.
class SpyResizeObserver {
  static instances: SpyResizeObserver[] = [];
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  constructor(_cb: ResizeObserverCallback) {
    SpyResizeObserver.instances.push(this);
  }
}

afterEach(() => {
  cleanup();
  SpyResizeObserver.instances = [];
  vi.restoreAllMocks();
});

function makeAnchor(host: Element, range: Range | null): ReferenceAnchor {
  return { host, range };
}

// jsdom's Range has no getClientRects at all (not even a no-op) — vi.spyOn
// requires the property to already exist, so wrap it as a plain own-property
// stub instead. Returns a vi.fn() the test can assert on directly.
function stubGetClientRects(range: Range, rects: DOMRect[]) {
  const stub = vi.fn(() => rects as unknown as DOMRectList);
  (range as unknown as { getClientRects: typeof stub }).getClientRects = stub;
  return stub;
}

describe('useReferenceGeometry', () => {
  it('returns an empty path when anchor is null', () => {
    (global as any).ResizeObserver = SpyResizeObserver;
    const { result } = renderHook(() => useReferenceGeometry(null));
    expect(result.current.d).toBe('');
  });

  it('uses the range rects when the range is contained in the host', () => {
    (global as any).ResizeObserver = SpyResizeObserver;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const text = document.createTextNode('hello world');
    host.appendChild(text);

    const range = document.createRange();
    range.selectNodeContents(text);
    // Prove the range branch ran (not the host-box fallback) by checking
    // which stub the hook actually called.
    const rectsStub = stubGetClientRects(range, [
      { left: 1, right: 2, top: 3, bottom: 4, width: 1, height: 1 } as DOMRect,
    ]);
    const hostRectSpy = vi.spyOn(host, 'getBoundingClientRect');

    const anchor = makeAnchor(host, range); // constructed once — see file header
    const { result } = renderHook(() => useReferenceGeometry(anchor));

    expect(rectsStub).toHaveBeenCalled();
    expect(hostRectSpy).not.toHaveBeenCalled();
    // `d` is non-empty proof the range branch's rect fed the path builder —
    // the raw rects themselves are no longer exposed (Task 8 deleted the
    // unused `rects` field; nothing outside this hook ever consumed it once
    // the artifact clip-path switched to reusing `d` directly).
    expect(result.current.d).not.toBe('');

    document.body.removeChild(host);
  });

  // The containment guard is the subtle, load-bearing requirement carried
  // over from the withdrawn surroundContents() design (see the WHY comment in
  // use-reference-geometry.ts): a Range whose commonAncestorContainer is NOT
  // inside the host must be treated as if there were no selection at all, and
  // the hook must fall back to the whole-host box instead of tracing the
  // (out-of-bounds) range.
  it('falls back to the whole-host box when the range escapes the host (containment guard)', () => {
    (global as any).ResizeObserver = SpyResizeObserver;
    const host = document.createElement('div');
    host.appendChild(document.createTextNode('inside host'));
    document.body.appendChild(host);

    // A range over content that lives OUTSIDE host — host.contains(...) is false.
    const outside = document.createElement('div');
    const outsideText = document.createTextNode('outside host');
    outside.appendChild(outsideText);
    document.body.appendChild(outside);

    const range = document.createRange();
    range.selectNodeContents(outsideText);
    expect(host.contains(range.commonAncestorContainer)).toBe(false); // sanity check on the fixture itself

    const rectsStub = stubGetClientRects(range, [{ left: 999, right: 999, top: 999, bottom: 999, width: 1, height: 1 } as DOMRect]);
    const hostRectSpy = vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      left: 10, right: 20, top: 30, bottom: 40, width: 10, height: 10,
    } as DOMRect);

    const anchor = makeAnchor(host, range); // constructed once — see file header
    const { result } = renderHook(() => useReferenceGeometry(anchor));

    // The range must never even be consulted once containment fails.
    expect(rectsStub).not.toHaveBeenCalled();
    expect(hostRectSpy).toHaveBeenCalled();
    expect(result.current.d).not.toBe('');

    document.body.removeChild(host);
    document.body.removeChild(outside);
  });

  it('falls back to the whole-host box when anchor.range is null (whole-element reference)', () => {
    (global as any).ResizeObserver = SpyResizeObserver;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const hostRectSpy = vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      left: 0, right: 5, top: 0, bottom: 5, width: 5, height: 5,
    } as DOMRect);

    const anchor = makeAnchor(host, null); // constructed once — see file header
    const { result } = renderHook(() => useReferenceGeometry(anchor));

    expect(hostRectSpy).toHaveBeenCalled();
    expect(result.current.d).not.toBe('');

    document.body.removeChild(host);
  });

  it('returns an empty path when the host has been disconnected from the DOM', () => {
    (global as any).ResizeObserver = SpyResizeObserver;
    const host = document.createElement('div'); // never appended -> isConnected === false
    const anchor = makeAnchor(host, null); // constructed once — see file header
    const { result } = renderHook(() => useReferenceGeometry(anchor));
    expect(result.current.d).toBe('');
  });

  it('registers resize/scroll listeners and a ResizeObserver on mount, and tears every one of them down on unmount', () => {
    (global as any).ResizeObserver = SpyResizeObserver;
    const host = document.createElement('div');
    document.body.appendChild(host);
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      left: 0, right: 1, top: 0, bottom: 1, width: 1, height: 1,
    } as DOMRect);

    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const anchor = makeAnchor(host, null); // constructed once — see file header
    const { unmount } = renderHook(() => useReferenceGeometry(anchor));

    expect(addSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    // capture: true is load-bearing — scroll doesn't bubble, and the chat /
    // artifact panes are the actual scrollers, not window itself.
    expect(addSpy).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(SpyResizeObserver.instances).toHaveLength(1);
    expect(SpyResizeObserver.instances[0].observe).toHaveBeenCalledWith(host);
    expect(SpyResizeObserver.instances[0].disconnect).not.toHaveBeenCalled();

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(SpyResizeObserver.instances[0].disconnect).toHaveBeenCalledTimes(1);

    document.body.removeChild(host);
  });

  it('does not register any listeners when anchor is null (nothing to leak)', () => {
    (global as any).ResizeObserver = SpyResizeObserver;
    const addSpy = vi.spyOn(window, 'addEventListener');
    const { unmount } = renderHook(() => useReferenceGeometry(null));
    expect(addSpy).not.toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(SpyResizeObserver.instances).toHaveLength(0);
    unmount(); // must not throw with nothing to clean up
  });

  it('swapping anchor from a live host to null tears down the previous listeners (no post-unmount setState leak)', () => {
    (global as any).ResizeObserver = SpyResizeObserver;
    const host = document.createElement('div');
    document.body.appendChild(host);
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      left: 0, right: 1, top: 0, bottom: 1, width: 1, height: 1,
    } as DOMRect);

    const initialAnchor = makeAnchor(host, null); // constructed once — see file header
    // Explicit generic args: renderHook infers its Props type param from
    // BOTH the callback's parameter AND `initialProps` together and narrows
    // to the non-null `{ anchor: ReferenceAnchor }` from initialProps alone
    // even with the callback annotated `| null` — leaving the later
    // `rerender({ anchor: null })` call failing to typecheck. Pinning the
    // generics directly sidesteps the inference instead of fighting it.
    const { result, rerender } = renderHook<{ d: string }, { anchor: ReferenceAnchor | null }>(
      ({ anchor }) => useReferenceGeometry(anchor),
      { initialProps: { anchor: initialAnchor } },
    );
    expect(result.current.d).not.toBe('');
    expect(SpyResizeObserver.instances[0].disconnect).not.toHaveBeenCalled();

    rerender({ anchor: null });

    // The effect cleanup for the PREVIOUS (non-null) anchor must have run
    // before the new (null) effect body — React guarantees this ordering —
    // so the old ResizeObserver is disconnected and geometry is cleared.
    expect(SpyResizeObserver.instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(result.current.d).toBe('');

    document.body.removeChild(host);
  });
});
