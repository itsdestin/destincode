import { useCallback } from 'react';

/**
 * A callback ref that observes an element with the given IntersectionObserver
 * and RELEASES it when React detaches the ref.
 *
 * WHY this exists as a hook rather than three inline lines (perf cycle 3):
 * an IntersectionObserver holds a STRONG reference to every target it observes.
 * ChatView attaches an observer ref to EVERY timeline entry, and the original
 * inline body only ever called `observe()`. Nothing removes a timeline entry
 * today, so nothing leaked — but the first change that DOES remove one (evicting
 * an old turn, or collapsing a distant entry to a placeholder) would keep the
 * detached node reachable from the live observer and free nothing at all. That
 * failure is silent: the reducer looks right, the DOM looks right, every test
 * passes, and only a memory measurement disagrees. For scale, a conversation
 * read back to its beginning holds ~1.44M DOM nodes.
 *
 * ALWAYS RETURNS A CLEANUP — this is the load-bearing detail, and getting it
 * wrong broke five existing ChatView tests before it was caught. React 19
 * chooses the detach convention PER CALL: return a function and React invokes
 * that function on detach; return `undefined` and React falls back to invoking
 * the ref itself with `null`. The observer is created in an effect, so it does
 * not exist yet when refs attach on the first render — an early-return of
 * `undefined` there put that one ref on the null-call convention, and the next
 * detach re-entered this callback with `el === null` and passed it straight to
 * `observe()`. The observer callback then read `entry.target.classList` off
 * null. So: one convention, always, plus a defensive null check for any ref
 * already on the other one.
 *
 * The observer is read through a ref rather than passed by value so that the
 * callback identity stays stable across renders — a ref callback whose identity
 * changes is detached and re-attached on every render, which for a long
 * conversation is thousands of observe/unobserve pairs per frame.
 *
 * Guard: use-observed-ref.test.ts.
 */
export function useObservedRef<T extends Element>(
  observerRef: React.RefObject<IntersectionObserver | null>,
): (el: T | null) => () => void {
  return useCallback((el: T | null) => {
    const io = el ? observerRef.current : null;
    if (!io || !el) return NOOP;
    io.observe(el);
    return () => io.unobserve(el);
  }, [observerRef]);
}

// A single shared instance: returning a fresh `() => {}` per call would allocate
// one closure per timeline entry per render, on the render path this hook exists
// to make cheaper.
const NOOP = () => {};
