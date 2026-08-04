// @vitest-environment jsdom
// Fix: pin jsdom here because vitest.config.ts only auto-applies jsdom to
// tests under `tests/**/*.tsx`; this file lives under `src/**/*.test.ts`
// and would otherwise run in the default `node` env with no `window`.
//
// Restored 2026-07-28 with a NEW contract: the hook used to trace
// `anchor.range`/`anchor.host` (the SOURCE's position). It now traces the
// `.reference-mark` elements inside a given CONTAINER (the reference-lift
// clone) instead — see the WHY comment in use-reference-geometry.ts for why
// (fixes the travelling-card-outlines-empty-space bug by construction). Every
// test below exercises the new container-based contract; the old anchor-based
// tests are gone, not just extended, because the anchor is no longer this
// hook's input at all.
//
// What's testable here vs. not: jsdom has no real layout engine, so every
// DOMRect it hands back (getBoundingClientRect) is zeroed. What IS provable,
// and what these tests pin: (1) which marks get queried and measured, (2)
// that `d` reflects `reference-geometry.ts`'s pipeline (toBoxes ->
// mergeAdjacentBoxes -> buildRoundedOutlinePath) run over their rects, (3)
// that resize/scroll listeners and the transitionrun/transitionend tracking
// listeners are registered and torn down correctly, and (4) the no-marks /
// no-container / inactive fallbacks. A real dev-instance visual check (does
// the outline actually hug the highlighted text, does it track smoothly
// during the FLIP travel) is still required before shipping — see the task
// report; jsdom has no CSS transition engine, so `transitionrun` never
// actually fires here, only the listener registration is provable.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useReferenceGeometry } from './use-reference-geometry';
import { toBoxes, mergeAdjacentBoxes, buildRoundedOutlinePath } from './reference-geometry';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom implements Element.getClientRects() (unlike Range.getClientRects(),
// which it does NOT implement — see the old version of this file), but
// always returns an empty list (no layout engine) — stub it per-mark, same
// idiom the old file used for Range.
function stubMarkRects(mark: Element, rects: DOMRect[]) {
  (mark as unknown as { getClientRects: () => DOMRectList }).getClientRects = () =>
    rects as unknown as DOMRectList;
}

function makeContainerRef(container: HTMLElement | null) {
  return { current: container };
}

describe('useReferenceGeometry', () => {
  it('returns an empty path when the container is null', () => {
    const { result } = renderHook(() => useReferenceGeometry(makeContainerRef(null), true, 'k1'));
    expect(result.current.d).toBe('');
  });

  it('returns an empty path when inactive, even with a real container and marks', () => {
    const container = document.createElement('div');
    const mark = document.createElement('mark');
    mark.className = 'reference-mark';
    container.appendChild(mark);
    document.body.appendChild(container);
    stubMarkRects(mark, [{ left: 0, top: 0, right: 10, bottom: 20, width: 10, height: 20 } as DOMRect]);

    const { result } = renderHook(() => useReferenceGeometry(makeContainerRef(container), false, 'k1'));
    expect(result.current.d).toBe('');

    document.body.removeChild(container);
  });

  it('returns an empty path when the container has no .reference-mark descendants', () => {
    const container = document.createElement('div');
    container.textContent = 'whole-element reference, no partial selection';
    document.body.appendChild(container);

    const { result } = renderHook(() => useReferenceGeometry(makeContainerRef(container), true, 'k1'));
    expect(result.current.d).toBe('');

    document.body.removeChild(container);
  });

  it('traces the .reference-mark descendants, running their rects through the same geometry pipeline reference-geometry.ts exposes', () => {
    const container = document.createElement('div');
    const mark = document.createElement('mark');
    mark.className = 'reference-mark';
    container.appendChild(mark);
    document.body.appendChild(container);

    const rect = { left: 12.4, top: 8.6, right: 92.2, bottom: 28.3, width: 79.8, height: 19.7 } as DOMRect;
    stubMarkRects(mark, [rect]);

    const { result } = renderHook(() => useReferenceGeometry(makeContainerRef(container), true, 'k1'));

    const expectedD = buildRoundedOutlinePath(
      mergeAdjacentBoxes(toBoxes([rect], { left: 0, top: 0 } as DOMRect)),
    );
    expect(expectedD).not.toBe('');
    expect(result.current.d).toBe(expectedD);

    document.body.removeChild(container);
  });

  it('collects rects from MULTIPLE marks (a selection spanning several text runs)', () => {
    const container = document.createElement('div');
    const markA = document.createElement('mark');
    markA.className = 'reference-mark';
    const markB = document.createElement('mark');
    markB.className = 'reference-mark';
    container.append(markA, markB);
    document.body.appendChild(container);

    const rectA = { left: 40, top: 0, right: 100, bottom: 20, width: 60, height: 20 } as DOMRect;
    const rectB = { left: 0, top: 20, right: 60, bottom: 40, width: 60, height: 20 } as DOMRect;
    stubMarkRects(markA, [rectA]);
    stubMarkRects(markB, [rectB]);

    const { result } = renderHook(() => useReferenceGeometry(makeContainerRef(container), true, 'k1'));

    const expectedD = buildRoundedOutlinePath(
      mergeAdjacentBoxes(toBoxes([rectA, rectB], { left: 0, top: 0 } as DOMRect)),
    );
    expect(result.current.d).toBe(expectedD);
    expect(result.current.d).toContain('Q'); // rounded corners, not the old sharp-stepped path

    document.body.removeChild(container);
  });

  it('re-measures when remeasureKey changes (a new reference replaces the clone/marks)', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const mark1 = document.createElement('mark');
    mark1.className = 'reference-mark';
    container.appendChild(mark1);
    stubMarkRects(mark1, [{ left: 0, top: 0, right: 10, bottom: 20, width: 10, height: 20 } as DOMRect]);

    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useReferenceGeometry(makeContainerRef(container), true, key),
      { initialProps: { key: 'ref-1' } },
    );
    const firstD = result.current.d;
    expect(firstD).not.toBe('');

    // Simulate the clone-population effect replacing the marks for a NEW
    // reference (same container node, reused — see ReferenceOverlay.tsx).
    container.replaceChildren();
    const mark2 = document.createElement('mark');
    mark2.className = 'reference-mark';
    container.appendChild(mark2);
    stubMarkRects(mark2, [{ left: 200, top: 200, right: 260, bottom: 220, width: 60, height: 20 } as DOMRect]);

    rerender({ key: 'ref-2' });

    expect(result.current.d).not.toBe(firstD);
    expect(result.current.d).not.toBe('');

    document.body.removeChild(container);
  });

  it('exposes a stable remeasure() that recomputes on demand', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const { result, rerender } = renderHook(() => useReferenceGeometry(makeContainerRef(container), true, 'k1'));
    expect(result.current.d).toBe(''); // no marks yet

    const mark = document.createElement('mark');
    mark.className = 'reference-mark';
    container.appendChild(mark);
    stubMarkRects(mark, [{ left: 0, top: 0, right: 10, bottom: 20, width: 10, height: 20 } as DOMRect]);

    // Nothing in React knows the DOM changed — an explicit remeasure() call
    // (exactly what ReferenceOverlay.tsx's positioning effects do right
    // after setting left/top/transform) is what picks it up.
    result.current.remeasure();
    rerender();
    expect(result.current.d).not.toBe('');

    document.body.removeChild(container);
  });

  it('registers resize/scroll listeners AND transitionrun/transitionend/transitioncancel listeners on the container, tearing every one of them down on unmount', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    const addWindowSpy = vi.spyOn(window, 'addEventListener');
    const removeWindowSpy = vi.spyOn(window, 'removeEventListener');
    const addContainerSpy = vi.spyOn(container, 'addEventListener');
    const removeContainerSpy = vi.spyOn(container, 'removeEventListener');

    const { unmount } = renderHook(() => useReferenceGeometry(makeContainerRef(container), true, 'k1'));

    expect(addWindowSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    // capture: true is load-bearing — scroll doesn't bubble, and the chat /
    // artifact panes are the actual scrollers, not window itself.
    expect(addWindowSpy).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    // Native transition-tracking listeners (see the WHY comment in
    // use-reference-geometry.ts on why these are native DOM events, not a
    // React effect dependency on the transform value).
    expect(addContainerSpy).toHaveBeenCalledWith('transitionrun', expect.any(Function));
    expect(addContainerSpy).toHaveBeenCalledWith('transitionend', expect.any(Function));
    expect(addContainerSpy).toHaveBeenCalledWith('transitioncancel', expect.any(Function));

    unmount();

    expect(removeWindowSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(removeWindowSpy).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(removeContainerSpy).toHaveBeenCalledWith('transitionrun', expect.any(Function));
    expect(removeContainerSpy).toHaveBeenCalledWith('transitionend', expect.any(Function));
    expect(removeContainerSpy).toHaveBeenCalledWith('transitioncancel', expect.any(Function));

    document.body.removeChild(container);
  });

  it('does not register any listeners when inactive (nothing to leak)', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const addContainerSpy = vi.spyOn(container, 'addEventListener');

    const { unmount } = renderHook(() => useReferenceGeometry(makeContainerRef(container), false, 'k1'));
    expect(addContainerSpy).not.toHaveBeenCalledWith('transitionrun', expect.any(Function));
    unmount(); // must not throw with nothing to clean up

    document.body.removeChild(container);
  });

  it('does not register any listeners when the container is null', () => {
    const addWindowSpy = vi.spyOn(window, 'addEventListener');
    const { unmount } = renderHook(() => useReferenceGeometry(makeContainerRef(null), true, 'k1'));
    expect(addWindowSpy).not.toHaveBeenCalledWith('scroll', expect.any(Function), true);
    unmount(); // must not throw
  });

  it('going from active to inactive tears down the previous listeners and clears the path', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const mark = document.createElement('mark');
    mark.className = 'reference-mark';
    container.appendChild(mark);
    stubMarkRects(mark, [{ left: 0, top: 0, right: 10, bottom: 20, width: 10, height: 20 } as DOMRect]);

    const removeContainerSpy = vi.spyOn(container, 'removeEventListener');

    const { result, rerender } = renderHook<
      { d: string; remeasure: () => void },
      { active: boolean }
    >(({ active }) => useReferenceGeometry(makeContainerRef(container), active, 'k1'), {
      initialProps: { active: true },
    });
    expect(result.current.d).not.toBe('');

    rerender({ active: false });

    expect(removeContainerSpy).toHaveBeenCalledWith('transitionrun', expect.any(Function));
    expect(result.current.d).toBe('');

    document.body.removeChild(container);
  });
});
