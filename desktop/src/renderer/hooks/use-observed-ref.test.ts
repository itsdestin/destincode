// @vitest-environment jsdom
// The guard for perf cycle 3's prerequisite fix.
//
// THE POINT OF THIS FILE: an IntersectionObserver holds a STRONG reference to
// every element it observes. ChatView attaches an observer ref to EVERY timeline
// entry, so an entry removed from the DOM without an `unobserve` stays reachable
// from the live observer. Nothing removes a timeline entry today, which is
// exactly why this is dangerous: the leak is dormant, and the first change that
// removes an entry frees NOTHING while every other test still passes. The only
// symptom is a memory measurement that does not move.
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useObservedRef } from './use-observed-ref';

function fakeObserver() {
  return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() } as unknown as IntersectionObserver;
}

describe('useObservedRef', () => {
  it('observes the element it is attached to', () => {
    const io = fakeObserver();
    const { result } = renderHook(() => useObservedRef({ current: io }));
    const el = document.createElement('div');
    result.current(el);
    expect(io.observe).toHaveBeenCalledWith(el);
  });

  it('returns a cleanup that unobserves that same element', () => {
    // The whole fix. Without the returned cleanup the element is never released
    // and removing it from the DOM reclaims nothing.
    const io = fakeObserver();
    const { result } = renderHook(() => useObservedRef({ current: io }));
    const el = document.createElement('div');
    const cleanup = result.current(el);
    expect(typeof cleanup).toBe('function');
    (cleanup as () => void)();
    expect(io.unobserve).toHaveBeenCalledWith(el);
    expect(io.unobserve).toHaveBeenCalledTimes(1);
  });

  it('releases every element, not just the last one', () => {
    // A conversation read to its beginning holds thousands of entries; a
    // cleanup that closed over shared mutable state instead of its own element
    // would release one and leak the rest.
    const io = fakeObserver();
    const { result } = renderHook(() => useObservedRef({ current: io }));
    const els = [document.createElement('div'), document.createElement('div'), document.createElement('div')];
    const cleanups = els.map((el) => result.current(el) as () => void);
    cleanups.forEach((c) => c());
    expect((io.unobserve as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(els);
  });

  it('still returns a cleanup when there is no observer yet', () => {
    // REGRESSION (caught by five existing ChatView tests): React 19 picks the
    // detach convention per call. Returning `undefined` here — which happens on
    // the first render, because the observer is built in an effect that runs
    // after refs attach — puts that ref on the "call me with null" convention.
    // The next detach then re-entered this callback with el === null, passed it
    // to observe(), and the observer callback read `.classList` off null.
    // One convention, always.
    const ref: React.RefObject<IntersectionObserver | null> = { current: null };
    const { result } = renderHook(() => useObservedRef(ref));
    const cleanup = result.current(document.createElement('div'));
    expect(typeof cleanup).toBe('function');
    expect(() => cleanup()).not.toThrow();
  });

  it('never passes a null element to observe()', () => {
    // The other half of the same regression: a ref left on the null-call
    // convention by an earlier render re-enters here with null.
    const io = fakeObserver();
    const { result } = renderHook(() => useObservedRef({ current: io }));
    expect(() => result.current(null)).not.toThrow();
    expect(io.observe).not.toHaveBeenCalled();
  });

  it('keeps a stable identity across renders', () => {
    // A ref callback whose identity changes is detached and re-attached by React
    // on EVERY render. For a long conversation that is thousands of
    // observe/unobserve pairs per frame — a performance bug introduced by the
    // performance fix.
    const ref: React.RefObject<IntersectionObserver | null> = { current: fakeObserver() };
    const { result, rerender } = renderHook(() => useObservedRef(ref));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
