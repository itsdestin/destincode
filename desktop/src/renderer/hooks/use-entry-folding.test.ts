// @vitest-environment jsdom
// Guard for perf cycle 3's folding controller.
//
// THE POINT OF THIS FILE: folding replaces a distant entry's body with a spacer
// of the height it last occupied. Every way that can go wrong is a way to move
// the scroll position under a reader, which is the one regression in this area
// the user has already reported by feel. So the cases here are the ones where a
// naive implementation silently produces a WRONG HEIGHT or folds at the wrong
// moment — not the happy path.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEntryFolding, FOLD_IDLE_MS, UNFOLD_DEBOUNCE_MS, FOLD_ROOT_MARGIN } from './use-entry-folding';

type Cb = (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;
let fire: Cb;
let observed: Element[];
let lastOptions: IntersectionObserverInit | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  observed = [];
  (globalThis as any).IntersectionObserver = class {
    constructor(cb: Cb, options?: IntersectionObserverInit) { fire = cb; lastOptions = options; }
    observe(el: Element) { observed.push(el); }
    unobserve(el: Element) { observed = observed.filter((o) => o !== el); }
    disconnect() { observed = []; }
    takeRecords() { return []; }
  };
});
afterEach(() => { vi.useRealTimers(); });

/** An entry wrapper with a real offsetHeight, which jsdom does not compute. */
function entry(key: string, height: number) {
  const el = document.createElement('div');
  el.dataset.entryKey = key;
  Object.defineProperty(el, 'offsetHeight', { get: () => height, configurable: true });
  return el;
}

describe('useEntryFolding', () => {
  it('folds an entry that scrolled away, at the height it last occupied', () => {
    const { result } = renderHook(() => useEntryFolding(true));
    const el = entry('a', 240);
    act(() => { result.current.registerEntry(el); });

    act(() => { fire([{ target: el, isIntersecting: true }]); vi.advanceTimersByTime(UNFOLD_DEBOUNCE_MS); });
    expect(result.current.isFolded('a')).toBe(false);

    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.isFolded('a')).toBe(true);
    expect(result.current.heightOf('a')).toBe(240);
  });

  it('NEVER folds an entry whose height was never measured', () => {
    // The scroll-destroying case: an entry created off-screen and never seen has
    // no measured height, so a spacer for it would be 0px and the scroll height
    // would collapse under the reader.
    const { result } = renderHook(() => useEntryFolding(true));
    const el = entry('never-seen', 500);
    act(() => { result.current.registerEntry(el); });
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.isFolded('never-seen')).toBe(false);
  });

  it('does not re-measure while folded, so the spacer height cannot drift', () => {
    // A folded entry's offsetHeight IS the spacer. Measuring then would overwrite
    // the true height with itself once, and with a stale value forever after.
    const { result } = renderHook(() => useEntryFolding(true));
    const el = entry('b', 300);
    act(() => { result.current.registerEntry(el); });
    act(() => { fire([{ target: el, isIntersecting: true }]); vi.advanceTimersByTime(UNFOLD_DEBOUNCE_MS); });
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.heightOf('b')).toBe(300);

    // Now the element reports the spacer height, as the real DOM would.
    Object.defineProperty(el, 'offsetHeight', { get: () => 300, configurable: true });
    // A brief re-intersect that does not survive the debounce must not re-measure.
    act(() => { fire([{ target: el, isIntersecting: true }]); });
    expect(result.current.heightOf('b')).toBe(300);
  });

  it('waits for scrolling to settle before folding, but unfolds promptly', () => {
    // Folding mid-scroll re-renders the list under a moving viewport. Unfolding
    // late shows a blank gap. The asymmetry is the whole point.
    const { result } = renderHook(() => useEntryFolding(true));
    const el = entry('c', 120);
    act(() => { result.current.registerEntry(el); });
    act(() => { fire([{ target: el, isIntersecting: true }]); vi.advanceTimersByTime(UNFOLD_DEBOUNCE_MS); });

    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS - 50); });
    expect(result.current.isFolded('c')).toBe(false);
    // Still scrolling: another out-of-view report restarts the idle timer.
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS - 50); });
    expect(result.current.isFolded('c')).toBe(false);
    act(() => { vi.advanceTimersByTime(60); });
    expect(result.current.isFolded('c')).toBe(true);

    act(() => { fire([{ target: el, isIntersecting: true }]); vi.advanceTimersByTime(UNFOLD_DEBOUNCE_MS); });
    expect(result.current.isFolded('c')).toBe(false);
  });

  it('unfolds everything and stops folding when disabled (the find bar is open)', () => {
    // ContentFindBar walks the DOM with a TreeWalker. A folded entry is
    // unfindable, so find would report "0 results" for text the user can see in
    // their own conversation.
    const { result, rerender } = renderHook(({ on }) => useEntryFolding(on), { initialProps: { on: true } });
    const el = entry('d', 90);
    act(() => { result.current.registerEntry(el); });
    act(() => { fire([{ target: el, isIntersecting: true }]); vi.advanceTimersByTime(UNFOLD_DEBOUNCE_MS); });
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.isFolded('d')).toBe(true);

    rerender({ on: false });
    expect(result.current.isFolded('d')).toBe(false);

    // And nothing folds again while it stays disabled.
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS * 2); });
    expect(result.current.isFolded('d')).toBe(false);
  });

  it('observes with a margin far wider than the blur observer, and releases on detach', () => {
    // 1500px, not the .in-view observer's 200px: folding something just off
    // screen unfolds it again on the next flick of the wheel, and the render
    // churn costs more than the memory it saves.
    expect(FOLD_ROOT_MARGIN).toBe('1500px 0px');
    const { result } = renderHook(() => useEntryFolding(true));
    const el = entry('e', 10);
    let release!: () => void;
    act(() => { release = result.current.registerEntry(el); });
    expect(lastOptions?.rootMargin).toBe(FOLD_ROOT_MARGIN);
    expect(observed).toContain(el);
    act(() => { release(); });
    expect(observed).not.toContain(el);
  });

  it('keeps registerEntry stable across renders and across fold-state changes', () => {
    // A ref callback whose identity changes is detached and re-attached by React
    // on EVERY entry, EVERY render. At 7,000 entries that is 7,000
    // unobserve+observe pairs per render, and because observe() delivers a fresh
    // intersection report each time, it also restarted the fold idle timer — so
    // folding could never fire and the change measured WORSE than doing nothing.
    const { result, rerender } = renderHook(() => useEntryFolding(true));
    const first = result.current.registerEntry;
    rerender();
    expect(result.current.registerEntry).toBe(first);

    const el = entry('f', 50);
    act(() => { result.current.registerEntry(el); });
    act(() => { fire([{ target: el, isIntersecting: true }]); vi.advanceTimersByTime(UNFOLD_DEBOUNCE_MS); });
    act(() => { fire([{ target: el, isIntersecting: false }]); vi.advanceTimersByTime(FOLD_IDLE_MS); });
    expect(result.current.isFolded('f')).toBe(true);   // state really did change
    expect(result.current.registerEntry).toBe(first);  // and the ref did not
  });

  it('returns a cleanup even with no element or no observer', () => {
    // Same contract as useObservedRef: returning undefined puts the ref on
    // React's null-call convention and the next detach re-enters with null.
    const { result } = renderHook(() => useEntryFolding(true));
    expect(typeof result.current.registerEntry(null)).toBe('function');
    expect(() => (result.current.registerEntry(null))()).not.toThrow();
  });
});
