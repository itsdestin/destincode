import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Perf cycle 3 — stop DRAWING conversation entries that are far off screen,
 * without removing anything from the reducer.
 *
 * WHY THIS SHAPE, and not the two obvious alternatives:
 *
 *  * `content-visibility: auto` is closed. globals.css records it being reverted
 *    because its implicit `contain: paint` clips the box-shadow glows community
 *    themes draw. `.timeline-entry` keeps `contain: layout style` for that reason.
 *
 *  * EVICTING the entries from the reducer was specced and rejected on review
 *    (2026-08-28). Deleting a turn leaves its uuids in `seenUuids`, so scrolling
 *    back replays a page in which every event is dropped as already-seen — the
 *    messages are gone for the session — and clearing those uuids instead makes
 *    `mergeTotals` re-add the page's tokens on every re-fetch. Beyond that,
 *    ~15 readers fold the whole session-lifetime `toolCalls` / `toolGroups` /
 *    `assistantTurns` maps (the specialists ledger, `/copy`, `/usage`, task
 *    counts, an assistant turn whose record is missing renders as a silent hole).
 *
 * Folding touches NONE of that. The timeline entry, its reducer records and its
 * uuids all stay; only the rendered body goes, replaced by a spacer of exactly
 * the height it last occupied. So the scroll height never changes, there is
 * nothing to re-fetch, and unfolding is a render rather than a disk read.
 * Measured cost of not doing this: a conversation read to its beginning holds
 * ~1.44M DOM nodes and ~1.9 GB of non-JS memory.
 *
 * Guard: use-entry-folding.test.ts.
 */

/**
 * How far outside the viewport an entry must be before it is a fold candidate.
 *
 * Deliberately much wider than the `.in-view` observer's 200px: that one gates a
 * backdrop-filter and wants to be tight, while this one governs whether content
 * EXISTS. Folding something 200px away would unfold it again on the next flick
 * of the wheel, and the render churn would be worse than the memory it saved.
 * At ~1.5 screens either side this keeps roughly 3-4 screens of real content
 * mounted, which for the 7,000-entry fixture is ~100 entries instead of 7,000.
 */
export const FOLD_ROOT_MARGIN = '1500px 0px';

/**
 * Folding waits for scrolling to STOP; unfolding does not.
 *
 * Asymmetric on purpose. Unfolding late shows the user a blank gap, so it runs
 * on a short debounce — and FOLD_ROOT_MARGIN means it fires ~1.5 screens before
 * the entry could be seen. Folding late costs nothing but memory, so it waits
 * for an idle moment: folding mid-scroll re-renders the list under a moving
 * viewport, and scroll judder is the one regression in this area the user has
 * already reported by feel (2026-08-28, cycle 2).
 */
export const UNFOLD_DEBOUNCE_MS = 100;
export const FOLD_IDLE_MS = 800;

interface FoldState {
  folded: ReadonlySet<string>;
  heights: ReadonlyMap<string, number>;
}

const EMPTY: FoldState = { folded: new Set(), heights: new Map() };

export interface EntryFolding {
  /** Callback ref for a timeline entry wrapper. Stable across renders. */
  registerEntry: (el: HTMLElement | null) => () => void;
  isFolded: (key: string) => boolean;
  heightOf: (key: string) => number | undefined;
}

/**
 * @param enabled  false suspends folding AND unfolds everything — used while the
 *   find bar is open, because `ContentFindBar` finds text by walking the DOM
 *   (`document.createTreeWalker`), so a folded entry is unfindable. Find is a
 *   deliberate user action on a bounded conversation, so paying the full DOM back
 *   for its duration is the right trade; the alternative is telling the user
 *   "0 results" for text that is in their conversation.
 */
export function useEntryFolding(enabled: boolean): EntryFolding {
  const [state, setState] = useState<FoldState>(EMPTY);

  // Everything the observer writes lives in refs. A setState per intersection
  // would be one render per entry per scroll — the observer fires for hundreds
  // of elements at a time, and this hook exists to make rendering cheaper.
  const heights = useRef(new Map<string, number>());
  const folded = useRef(new Set<string>());
  // MEMBERSHIP, not a queue — and that distinction is the whole correctness
  // argument. The first version drained a `pendingFold` queue and cleared it,
  // skipping any entry with no measured height yet. An entry prepended above the
  // viewport is observed while ALREADY outside the band, so its one and only
  // out-of-view report arrives before it has ever been seen or measured: it was
  // skipped, cleared, and — because IntersectionObserver reports TRANSITIONS and
  // it never transitions again — could never be folded for the rest of the
  // session. Measured: 741 of 12,100 entries folded, 6%. Holding membership
  // instead means every flush re-evaluates every out-of-view entry, so one that
  // becomes measurable later is picked up by the next flush.
  const outOfView = useRef(new Set<string>());
  const observer = useRef<IntersectionObserver | null>(null);
  const unfoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const foldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const publish = useCallback(() => {
    setState({ folded: new Set(folded.current), heights: new Map(heights.current) });
  }, []);

  const flushUnfold = useCallback(() => {
    unfoldTimer.current = null;
    let changed = false;
    for (const key of folded.current) {
      if (!outOfView.current.has(key)) { folded.current.delete(key); changed = true; }
    }
    if (changed) publish();
  }, [publish]);

  const flushFold = useCallback(() => {
    foldTimer.current = null;
    if (!enabledRef.current) return;
    let changed = false;
    for (const key of outOfView.current) {
      // Never fold an entry whose height was never measured: the spacer would be
      // 0px tall and the scroll height would collapse under the reader. It stays
      // in outOfView, so the next flush reconsiders it once it has been seen.
      if (!heights.current.has(key)) continue;
      if (!folded.current.has(key)) { folded.current.add(key); changed = true; }
    }
    if (changed) publish();
  }, [publish]);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.entryKey;
        if (!key) continue;
        if (entry.isIntersecting) {
          // Measure ONLY while unfolded — a folded entry's offsetHeight is the
          // spacer we set, so measuring then would freeze it forever at whatever
          // it happened to be, and re-measuring a stale value is how a list
          // slowly drifts out of alignment with its own scroll height.
          if (!folded.current.has(key)) {
            const h = (entry.target as HTMLElement).offsetHeight;
            if (h > 0) heights.current.set(key, h);
          }
          outOfView.current.delete(key);
          if (unfoldTimer.current == null) unfoldTimer.current = setTimeout(flushUnfold, UNFOLD_DEBOUNCE_MS);
        } else {
          outOfView.current.add(key);
          // Restarted on every out-of-view report, so this only fires once the
          // scroll has actually settled.
          if (foldTimer.current != null) clearTimeout(foldTimer.current);
          foldTimer.current = setTimeout(flushFold, FOLD_IDLE_MS);
        }
      }
    }, { rootMargin: FOLD_ROOT_MARGIN });
    observer.current = io;
    return () => {
      io.disconnect();
      observer.current = null;
      if (unfoldTimer.current != null) clearTimeout(unfoldTimer.current);
      if (foldTimer.current != null) clearTimeout(foldTimer.current);
      unfoldTimer.current = null;
      foldTimer.current = null;
    };
  }, [flushFold, flushUnfold]);

  // Suspending folding must unfold what is already folded, synchronously enough
  // that the find bar never walks a DOM with holes in it.
  useEffect(() => {
    if (enabled) return;
    if (foldTimer.current != null) { clearTimeout(foldTimer.current); foldTimer.current = null; }
    if (folded.current.size === 0) return;
    folded.current.clear();
    publish();
  }, [enabled, publish]);

  // Same contract as useObservedRef: ALWAYS return a cleanup, so React never
  // falls back to calling the ref with null (see that hook for the regression).
  const registerEntry = useCallback((el: HTMLElement | null) => {
    const io = el ? observer.current : null;
    if (!io || !el) return NOOP;
    io.observe(el);
    return () => io.unobserve(el);
  }, []);

  const isFolded = useCallback((key: string) => state.folded.has(key), [state]);
  const heightOf = useCallback((key: string) => state.heights.get(key), [state]);

  return { registerEntry, isFolded, heightOf };
}

const NOOP = () => {};
