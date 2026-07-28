// @vitest-environment jsdom
// Fix: pin jsdom explicitly (see use-esc-close.test.tsx for why) — this file
// lives under src/**/*.test.tsx, outside vitest.config.ts's tests/**/*.tsx
// auto-jsdom glob.
import React, { useEffect, useState } from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react';
import { EscCloseProvider, useEscClose } from '../../hooks/use-esc-close';
import { ReferenceProvider, useReference, type PendingReference } from '../../state/reference-context';
import { ThemeProvider } from '../../state/theme-context';
import { ReferenceOverlay } from './ReferenceOverlay';
import { REFERENCE_COMPOSER_Z } from '../overlays/Overlay';
import { toBoxes, buildUnionPath, shiftPath } from './reference-geometry';

// jsdom doesn't implement ResizeObserver (same stub as
// use-reference-geometry.test.ts). Only the Task 8 lift tests below drive a
// real (non-null) anchor through useReferenceGeometry, which is what
// actually constructs one — but defining it once at module scope is simpler
// than duplicating the stub per-test for just those cases.
class NoopResizeObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}
(global as any).ResizeObserver = NoopResizeObserver;

// ReferenceOverlay portals straight to document.body (window-wide, not scoped
// to RTL's per-test container), so an un-cleaned-up previous test's scrim
// stays in the DOM and a bare `querySelector('.reference-scrim')` in a LATER
// test can match the wrong instance. Explicit cleanup — this project doesn't
// register RTL's auto-cleanup globally (see InputBar.test.tsx, ToolCard.test.tsx).
afterEach(() => cleanup());

const mockReference: PendingReference = {
  kind: 'chat-text',
  label: 'a held reference',
  promptText: 'About this: hello world',
  anchor: null,
};

// Test-only bridge: ReferenceOverlay has no props, it reads context. To drive
// `reference` from a test we need a sibling that calls setReference — mirrors
// how a real caller (e.g. the context menu's "Ask about this" action) would.
function SetsReference({ value }: { value: PendingReference | null }) {
  const { setReference } = useReference();
  useEffect(() => { setReference(value); }, [value]);
  return null;
}

function renderOverlay(initial: PendingReference | null) {
  return render(
    <EscCloseProvider>
      <ReferenceProvider sessionId="test-session">
        <SetsReference value={initial} />
        <ReferenceOverlay />
      </ReferenceProvider>
    </EscCloseProvider>,
  );
}

describe('ReferenceOverlay', () => {
  it('renders nothing when no reference is held', () => {
    renderOverlay(null);
    expect(document.querySelector('.reference-scrim')).toBeNull();
  });

  it('renders a window-wide scrim when a reference is held', () => {
    renderOverlay(mockReference);
    act(() => {}); // settle the effect that pushes onto the Esc stack
    const scrim = document.querySelector('.reference-scrim');
    expect(scrim).not.toBeNull();
    // Portaled straight to document.body, not nested under the app tree —
    // that's what makes it window-wide rather than pane-scoped.
    expect(scrim?.parentElement).toBe(document.body);
  });

  it('clicking the scrim clears the reference', () => {
    renderOverlay(mockReference);
    act(() => {});
    const scrim = document.querySelector('.reference-scrim');
    expect(scrim).not.toBeNull();
    fireEvent.click(scrim as Element);
    act(() => {}); // clearReference→setReferenceState is async through context; flush it
    expect(document.querySelector('.reference-scrim')).toBeNull();
  });

  it('the cancel button clears the reference', () => {
    renderOverlay(mockReference);
    act(() => {});
    const cancelButton = document.querySelector('[aria-label="Cancel reference"]');
    expect(cancelButton).not.toBeNull();
    fireEvent.click(cancelButton as Element);
    act(() => {}); // same flush as above
    expect(document.querySelector('.reference-scrim')).toBeNull();
  });
});

// Review finding: the cancel button's wrapper is a SIBLING of
// .reference-lift-card inside .reference-lift, which globals.css sets
// pointer-events: none on. Only .reference-lift-card gets pointer-events:
// auto restored (globals.css ~line 955), so the wrapper — and everything in
// it, including the button — was NOT a hit-test target: hover never showed
// and the button's own onClick never fired. It only LOOKED like it worked
// because the click fell through to the full-viewport scrim underneath,
// whose onClick={clearReference} does the same thing for a different reason.
//
// jsdom has no real layout/paint engine, so it cannot honestly prove a click
// "reaches" the button through pointer-events — that's a hit-testing
// question a real browser answers, jsdom does not. What CAN be proven here,
// and what this test pins, is the mechanism the fix relies on: the wrapper
// carries the same `pointer-events-auto` class Toast.tsx's action slot uses
// to restore hit-testing under a pointer-events: none ancestor. A real
// dev-instance check (hover + click the Cancel button; confirm :hover
// actually paints, not just that SOMETHING dismisses the reference) is still
// required before shipping — see the task report.
describe('cancel button pointer-events (review finding)', () => {
  function wrapperOf(cancelButton: Element): Element {
    const wrapper = cancelButton.parentElement;
    if (!wrapper) throw new Error('cancel button has no parent wrapper');
    return wrapper;
  }

  it('travelling (chat) case: the cancel button wrapper carries pointer-events-auto', () => {
    renderOverlay(mockReference); // kind: 'chat-text' -> travels
    act(() => {});

    const lift = document.querySelector('.reference-lift');
    expect(lift?.getAttribute('data-travels')).toBe('true'); // sanity: this IS the travelling case

    const cancelButton = document.querySelector('[aria-label="Cancel reference"]');
    expect(cancelButton).not.toBeNull();
    const wrapper = wrapperOf(cancelButton as Element);
    // The wrapper must restore pointer-events, since .reference-lift (its
    // ancestor) sets pointer-events: none and only .reference-lift-card — a
    // SIBLING of this wrapper, not an ancestor of it — gets it restored.
    expect(wrapper.className).toMatch(/\bpointer-events-auto\b/);
  });

  it('non-travelling (artifact) case: the cancel button wrapper carries pointer-events-auto', () => {
    renderOverlay({ kind: 'artifact', label: 'x', promptText: 'x', anchor: null });
    act(() => {});

    const lift = document.querySelector('.reference-lift');
    expect(lift?.hasAttribute('data-travels')).toBe(false); // sanity: this IS the non-travelling case

    const cancelButton = document.querySelector('[aria-label="Cancel reference"]');
    expect(cancelButton).not.toBeNull();
    const wrapper = wrapperOf(cancelButton as Element);
    expect(wrapper.className).toMatch(/\bpointer-events-auto\b/);
  });
});

// Review Finding 4: no test asserted the composer-lift mechanism at all.
// jsdom has no real layout engine, so none of this can prove actual paint
// order (i.e. that a click really lands on the textarea instead of the
// scrim) — that needs a real browser. What IS provable here, and what these
// tests pin: (1) the attribute + CSS var ReferenceOverlay publishes while a
// reference is held, cleaned up when it's cleared, and (2) that globals.css
// actually contains a rule consuming them. A real dev-instance visual check
// (click the composer while a reference is held; confirm it types/sends
// instead of dismissing the reference) is still required before shipping —
// see the task report for what was checked there.
describe('composer lift (review Finding 1/2/4)', () => {
  it('publishes data-reference-held + --reference-composer-z on body while held, clears both when cleared', () => {
    renderOverlay(mockReference);
    act(() => {});
    expect(document.body.getAttribute('data-reference-held')).toBe('true');
    expect(document.body.style.getPropertyValue('--reference-composer-z')).toBe(String(REFERENCE_COMPOSER_Z));

    const cancelButton = document.querySelector('[aria-label="Cancel reference"]');
    fireEvent.click(cancelButton as Element);
    act(() => {});
    expect(document.body.hasAttribute('data-reference-held')).toBe(false);
    // jsdom returns '' for a removed custom property, not undefined/null.
    expect(document.body.style.getPropertyValue('--reference-composer-z')).toBe('');
  });

  it('globals.css raises .bottom-float above the scrim only while held, reading the number from the published var (not hardcoded)', () => {
    // Source-text assertion, same idiom as tests/overlay-layer-authority.test.ts:
    // greps for the rule rather than rendering, since jsdom can't compute real
    // stacking order. Guards against a future edit reintroducing a magic
    // z-index literal here instead of var(--reference-composer-z), which would
    // both violate design rule 11 and silently stop tracking Overlay.tsx if
    // REFERENCE_COMPOSER_Z's value ever changes.
    const css = readFileSync(join(__dirname, '..', '..', 'styles', 'globals.css'), 'utf8');
    expect(css).toMatch(/body\[data-reference-held\]\s+\.bottom-float\s*\{[^}]*z-index:\s*var\(--reference-composer-z/);
  });
});

// Review Finding 3: the depth-cancel effect compares Esc-stack DEPTH, not
// closer IDENTITY. Judgement call (see the WHY comment in ReferenceOverlay.tsx
// above the `if (depth > depthAtOpen.current)` check): when this component's
// own useEscClose push and some OTHER overlay's first-ever push land in the
// exact same React commit (one event handler synchronously triggering both,
// batched by React 18 into one passive-effect flush), the count-based check
// can't tell whether the other push landed above or below this one in the
// LIFO stack — it only sees depth grow by 2 instead of the expected 1, so it
// cancels regardless of ordering. This was judged an ACCEPTABLE, SAFE
// behavior (any contention for the L2 band yields, same-commit or not) rather
// than worth an identity-based rewrite of the shared, app-wide useEscClose
// stack. This test PINS that choice against regression — it is not a "this is
// definitely optimal" claim, just "this is what the codebase has decided,
// don't silently change it."
describe('depth-cancel race (review Finding 3 — documented, accepted behavior)', () => {
  it('reference yields when another overlay registers its first useEscClose push in the SAME commit', () => {
    // Registers unconditionally-but-controlled by `open`, mirroring how a real
    // overlay wires useEscClose — the point is that flipping `open` to true is
    // this component's FIRST push, same as ReferenceOverlay's own first push
    // when `reference` goes from null to non-null.
    function ConcurrentOverlay({ open }: { open: boolean }) {
      useEscClose(open, () => {});
      return null;
    }

    function Trigger({ value }: { value: PendingReference }) {
      const { setReference } = useReference();
      const [otherOpen, setOtherOpen] = useState(false);
      return (
        <>
          <button
            onClick={() => {
              // Single synchronous event handler → React 18 automatic batching
              // → ONE commit covers both updates, so ConcurrentOverlay's push
              // effect and ReferenceOverlay's own push effect fire in the SAME
              // passive-effect flush. This is the reproduction of Finding 3's
              // race — NOT the same thing as the already-fixed self-registration
              // off-by-one (that one only ever involved ReferenceOverlay's own
              // single push; this one involves two independent pushes landing
              // together).
              setOtherOpen(true);
              setReference(value);
            }}
          >
            trigger
          </button>
          <ConcurrentOverlay open={otherOpen} />
        </>
      );
    }

    render(
      <EscCloseProvider>
        <ReferenceProvider sessionId="test-session">
          <Trigger value={mockReference} />
          <ReferenceOverlay />
        </ReferenceProvider>
      </EscCloseProvider>,
    );
    fireEvent.click(screen.getByText('trigger'));
    act(() => {});

    expect(document.querySelector('.reference-scrim')).toBeNull();
  });
});

// Task 8: the lift. jsdom has no real layout engine, so getBoundingClientRect
// on an unmocked element is all-zeros and there is no way to assert the FLIP
// transition's actual transform PIXEL values here — a real dev-instance
// visual check (does the newest message, right above the composer, actually
// glide to centre; does a long message scroll internally instead of
// overflowing; does a multi-line artifact clip track scrolling) is still
// required before shipping, per the task brief. What IS provable in jsdom,
// and what these tests pin: (1) which element kinds travel vs. don't, (2)
// that the lifted card is a `cloneNode` copy — not the source itself, not an
// innerHTML re-parse — and that the source is left byte-identical, and (3)
// that the artifact clip-path is `d` SHIFTED by the source's own rect, not
// `d` used as-is (the coordinate-system bug the brief's literal `path(d)`
// would have shipped — see the WHY comment on the `shiftPath` call in
// ReferenceOverlay.tsx for the CSS Shapes spec citation), and (4) that
// nothing survives in the DOM once the reference clears.
describe('lift (Task 8: FLIP travel + artifact clip)', () => {
  function makeHost(text: string): HTMLElement {
    const host = document.createElement('div');
    host.setAttribute('data-test-marker', 'source');
    host.textContent = text;
    document.body.appendChild(host);
    return host;
  }

  it('a chat reference clones the source via cloneNode, travels, and leaves the source unmutated', () => {
    const host = makeHost('the referenced message');
    const originalOuterHTML = host.outerHTML;

    renderOverlay({
      kind: 'chat-text',
      label: 'x',
      promptText: 'x',
      anchor: { host, range: null },
    });
    act(() => {});

    const lift = document.querySelector('.reference-lift');
    expect(lift).not.toBeNull();
    expect(lift?.getAttribute('data-travels')).toBe('true');

    const card = document.querySelector('.reference-lift-card');
    const clone = card?.firstElementChild;
    expect(clone).not.toBeNull();
    // A DIFFERENT node than the source — proves this is cloneNode output,
    // not a re-parent/move of the original (which would detach it from the
    // transcript) and not a live reference to it.
    expect(clone).not.toBe(host);
    expect(clone?.outerHTML).toBe(originalOuterHTML);
    expect(clone?.getAttribute('data-test-marker')).toBe('source');

    // No DOM mutation in the reference path — the invariant this whole
    // feature is built around (see reference-context.tsx's WHY comment on
    // the withdrawn Range.surroundContents() design, which crashed the
    // renderer). The source keeps its exact original markup and stays
    // attached exactly where it always was.
    expect(host.outerHTML).toBe(originalOuterHTML);
    expect(host.isConnected).toBe(true);
    expect(host.parentElement).toBe(document.body);

    document.body.removeChild(host);
  });

  it('an artifact reference does NOT travel and clips the clone to the selection, shifted into the clone\'s own coordinate space', () => {
    const host = makeHost('const x = 1;');
    // jsdom's own getBoundingClientRect is all-zero (no layout engine) —
    // stub a real rect so the clip-path math has something non-degenerate to
    // shift, same idiom as use-reference-geometry.test.ts.
    const rect = { left: 10, top: 20, right: 110, bottom: 70, width: 100, height: 50 } as DOMRect;
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect);

    renderOverlay({
      kind: 'artifact',
      label: 'lines 1-1 of x.ts',
      promptText: 'x',
      anchor: { host, range: null },
    });
    act(() => {});

    const lift = document.querySelector('.reference-lift') as HTMLElement;
    expect(lift).not.toBeNull();
    // Absent, not merely falsy — globals.css' `:not([data-travels="true"])`
    // selector depends on the attribute not being present at all.
    expect(lift.hasAttribute('data-travels')).toBe(false);
    expect(lift.style.transform).toBe('translate(0, 0)');

    // The clip-path must be `d` SHIFTED by the source's own rect, not `d`
    // used as-is. `clip-path: path()` resolves its coordinates against the
    // CLIPPED ELEMENT's own border box (confirmed against the CSS Shapes
    // spec), and this element's border box starts at (rect.left, rect.top),
    // not (0, 0) — so the raw viewport-relative `d` would clip the wrong
    // region if used unshifted. This is exactly the "reuses buildUnionPath
    // unchanged" pipeline the geometry hook already runs, recomputed here
    // and compared against what the effect actually wrote.
    const expectedD = buildUnionPath(toBoxes([rect], { left: 0, top: 0 } as DOMRect));
    const expectedClip = `path('${shiftPath(expectedD, -rect.left, -rect.top)}')`;
    expect(lift.style.clipPath).toBe(expectedClip);
    // Sanity check that the shift is load-bearing: the unshifted path is a
    // DIFFERENT string, so a regression back to `path(d)` (no shift) would
    // fail the assertion above rather than accidentally still pass.
    expect(expectedD).not.toBe(shiftPath(expectedD, -rect.left, -rect.top));

    document.body.removeChild(host);
  });

  it('clearing the reference unmounts the whole lift — no leaked clone left in the DOM', () => {
    const host = makeHost('goodbye');
    const { rerender } = renderOverlay({
      kind: 'chat-text',
      label: 'x',
      promptText: 'x',
      anchor: { host, range: null },
    });
    act(() => {});
    expect(document.querySelector('.reference-lift-card')?.firstElementChild).not.toBeNull();

    rerender(
      <EscCloseProvider>
        <ReferenceProvider sessionId="test-session">
          <SetsReference value={null} />
          <ReferenceOverlay />
        </ReferenceProvider>
      </EscCloseProvider>,
    );
    act(() => {});

    // ReferenceOverlay returns null (and its portal with it) once `reference`
    // clears, so .reference-lift and its card unmount together — nothing of
    // the clone survives detached in the DOM.
    expect(document.querySelector('.reference-lift')).toBeNull();
    expect(document.querySelector('.reference-lift-card')).toBeNull();

    document.body.removeChild(host);
  });
});

// Task 8 defect fix: the FLIP positioning effect used to depend on `d`
// (`[reference, travels, d]`). `d` is recomputed by useReferenceGeometry on
// EVERY scroll/resize event (see its measure() + window listeners), so
// scrolling at any point during the 460ms travel re-ran the whole effect:
// reset `transform` back to the source position and re-scheduled the RAF
// that glides it to centre, restarting the travel from scratch. `d` is only
// ever consumed by the non-travelling (artifact) branch's clip-path — the
// travelling (chat) branch never reads it. These tests pin the mechanism
// (effect re-run / transform rewrite), not pixel values — jsdom has no
// layout engine, so `window.innerWidth/innerHeight` and `node.offsetHeight`
// are whatever jsdom defaults to, not real numbers; what's provable is
// WHETHER the transform gets rewritten, not what it's rewritten TO.
describe('lift: scroll must not restart the travel animation (task-8 defect fix)', () => {
  function makeHost(text: string): HTMLElement {
    const host = document.createElement('div');
    host.setAttribute('data-test-marker', 'source');
    host.textContent = text;
    document.body.appendChild(host);
    return host;
  }

  // Real per-call rect, mutable so a later "scroll" can change what
  // getBoundingClientRect returns without changing the anchor's identity —
  // exactly what happens for a real scroll (the source's viewport position
  // moves; the reference itself doesn't change).
  function stubMovingRect(host: HTMLElement, initial: DOMRect) {
    let current = initial;
    vi.spyOn(host, 'getBoundingClientRect').mockImplementation(() => current);
    return {
      move(next: DOMRect) { current = next; },
    };
  }

  it('a chat (travelling) reference does not rewrite `transform` when only `d` changes (i.e. on scroll)', async () => {
    const host = makeHost('the referenced message');
    const rectCtl = stubMovingRect(host, {
      left: 10, top: 20, right: 110, bottom: 70, width: 100, height: 50,
    } as DOMRect);

    renderOverlay({
      kind: 'chat-text',
      label: 'x',
      promptText: 'x',
      anchor: { host, range: null },
    });
    act(() => {});
    // Let the RAF-scheduled "Last" transform apply (real timers — see the
    // raf-sanity check this fix was verified against: a real ~50ms wait is
    // enough for jsdom's requestAnimationFrame to fire).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const lift = document.querySelector('.reference-lift') as HTMLElement;
    expect(lift).not.toBeNull();
    const transformAfterTravel = lift.style.transform;
    // Sanity: the RAF callback ran and actually rewrote transform away from
    // the FLIP "First" position — otherwise the test below would trivially
    // pass for the wrong reason (nothing ever changed the string at all).
    expect(transformAfterTravel).not.toBe('translate(0, 0)');

    // Simulate a scroll: the source's viewport position changes AND
    // useReferenceGeometry's window-level 'scroll' listener (capture: true)
    // fires, forcing a re-measure that changes `d` — reference/travels are
    // untouched.
    rectCtl.move({ left: 400, top: 300, right: 500, bottom: 350, width: 100, height: 50 } as DOMRect);
    await act(async () => {
      fireEvent.scroll(window);
    });
    // Give any (wrongly) re-scheduled RAF a chance to fire too, so a
    // regression can't hide behind "the assertion ran before the RAF
    // callback landed." A separate act() call from the fireEvent above —
    // the scroll-triggered state update (measure() -> setGeom) needs its own
    // flush cycle before the effect that reads the new `d` even runs, so a
    // single combined act() can starve the RAF of time within one window.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    // The whole point of the fix: scrolling mid-travel must not touch
    // `transform` again. Before the fix, the effect re-ran on the `d`
    // change, reset `transform` to 'translate(0, 0)' synchronously, then
    // re-scheduled a fresh RAF — an observable restart of the glide.
    expect(lift.style.transform).toBe(transformAfterTravel);

    document.body.removeChild(host);
  });

  it('an artifact (non-travelling) reference DOES update its clip-path when `d` changes (i.e. on scroll)', async () => {
    const host = makeHost('const x = 1;');
    const rectCtl = stubMovingRect(host, {
      left: 10, top: 20, right: 110, bottom: 70, width: 100, height: 50,
    } as DOMRect);

    renderOverlay({
      kind: 'artifact',
      label: 'lines 1-1 of x.ts',
      promptText: 'x',
      anchor: { host, range: null },
    });
    act(() => {});

    const lift = document.querySelector('.reference-lift') as HTMLElement;
    expect(lift).not.toBeNull();
    const firstClip = lift.style.clipPath;
    expect(firstClip).not.toBe('none');

    // Move the source (simulating the artifact pane scrolling) and fire the
    // same window 'scroll' event useReferenceGeometry listens for. Width/
    // height are deliberately DIFFERENT from the initial rect, not just the
    // position: shiftPath re-expresses the path relative to the clone's own
    // box origin, so a same-size rect moved to a new (left, top) produces the
    // exact same shifted string — a real scroll can also change the box's
    // size (line wrap, reflow), and this is the only way to prove the effect
    // actually re-measured rather than coincidentally matching.
    const movedRect = { left: 400, top: 300, right: 540, bottom: 360, width: 140, height: 60 } as DOMRect;
    rectCtl.move(movedRect);
    act(() => { fireEvent.scroll(window); });

    // Unlike the travelling case above, the artifact clip MUST track the
    // new rect — the selection moved with the page, so a stale clip would
    // reveal the wrong lines. Recompute independently (same idiom as the
    // existing artifact test above) rather than just asserting "changed".
    const expectedD = buildUnionPath(toBoxes([movedRect], { left: 0, top: 0 } as DOMRect));
    const expectedClip = `path('${shiftPath(expectedD, -movedRect.left, -movedRect.top)}')`;
    expect(lift.style.clipPath).toBe(expectedClip);
    expect(lift.style.clipPath).not.toBe(firstClip);

    document.body.removeChild(host);
  });
});

// Task 9: reduced-effects fallback. globals.css keys the whole branch off a
// `data-reduced` attribute stamped by THIS component (there's no
// data-reduced-effects attribute on <html> to select on — theme-engine.ts
// only zeroes blur vars for this setting, verified in the task brief), so the
// only honestly-checkable-in-jsdom claim is the mechanism: does the attribute
// land on `.reference-trace` and `.reference-lift` when reducedEffects is
// true, and is it ABSENT (not merely falsy — globals.css's `[data-reduced=
// "true"]` selector needs the attribute gone entirely) when it's false. What
// this can NOT prove — computed styles, whether the animation/glow/transition
// actually stop, whether the lift shadow visually drops back — needs a real
// dev-instance check (see the task report).
describe('dev-review fix: the highlight must not be left behind at the source', () => {
  function withHost(kind: PendingReference['kind']): PendingReference {
    const host = document.createElement('div');
    host.textContent = 'referenced content';
    document.body.appendChild(host);
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(
      { left: 10, top: 20, right: 110, bottom: 70, width: 100, height: 50 } as DOMRect,
    );
    return { kind, label: 'x', promptText: 'x', anchor: { host, range: null } };
  }

  it('a TRAVELLING (chat) reference renders no source-anchored trace', () => {
    // The card flies to the viewport centre, so a trace measured from the
    // source would outline the empty space the bubble left behind — the
    // "black box around where the message bubble was originally" Destin hit
    // in dev review. The travelling card carries its ring/glow in CSS instead.
    renderOverlay(withHost('chat-text'));
    act(() => {});
    expect(document.querySelector('.reference-lift')).not.toBeNull();
    expect(document.querySelector('.reference-trace')).toBeNull();
  });

  it('a NON-travelling (artifact) reference still renders the in-place trace', () => {
    // Nothing moves here, so the source-anchored outline is exactly right.
    renderOverlay(withHost('artifact'));
    act(() => {});
    expect(document.querySelector('.reference-trace')).not.toBeNull();
  });
});

describe('reduced effects (Task 9)', () => {
  const REDUCED_EFFECTS_KEY = 'youcoded-reduced-effects';

  // Fix: Node 22+ ships a stub globalThis.localStorage that lacks real
  // methods and throws without --localstorage-file — same fix as
  // useSessionTasks.test.tsx. Scoped to this describe block (not file-wide)
  // since it's the only place in this file that touches localStorage.
  function makeLocalStorageMock() {
    let store: Record<string, string> = {};
    return {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = String(value); },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { store = {}; },
      get length() { return Object.keys(store).length; },
      key: (n: number) => Object.keys(store)[n] ?? null,
    };
  }
  const lsMock = makeLocalStorageMock();
  beforeAll(() => { vi.stubGlobal('localStorage', lsMock); });
  afterAll(() => { vi.unstubAllGlobals(); });

  afterEach(() => {
    try { localStorage.removeItem(REDUCED_EFFECTS_KEY); } catch {}
  });

  function renderOverlayWithTheme(initial: PendingReference | null) {
    return render(
      <ThemeProvider>
        <EscCloseProvider>
          <ReferenceProvider sessionId="test-session">
            <SetsReference value={initial} />
            <ReferenceOverlay />
          </ReferenceProvider>
        </EscCloseProvider>
      </ThemeProvider>,
    );
  }

  // `.reference-trace` only renders when `d` is non-empty (`{d && (<svg .../>)}`
  // in ReferenceOverlay.tsx), and `d` is empty for a null anchor OR for jsdom's
  // default all-zero getBoundingClientRect (toBoxes drops zero-area rects) —
  // same reason the Task 8 lift tests above stub a real rect. A real host with
  // a stubbed rect is needed here so the trace svg actually mounts.
  function makeReferenceWithHost(): PendingReference {
    const host = document.createElement('div');
    host.textContent = 'the referenced message';
    document.body.appendChild(host);
    const rect = { left: 10, top: 20, right: 110, bottom: 70, width: 100, height: 50 } as DOMRect;
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect);
    return { kind: 'chat-text', label: 'x', promptText: 'x', anchor: { host, range: null } };
  }

  // The source-anchored trace svg only renders for NON-travelling (artifact)
  // references now — a travelling chat card carries its own ring/glow in CSS
  // so nothing is left behind at the source (dev-review fix). So the trace
  // half of these assertions needs an artifact reference.
  function makeArtifactReferenceWithHost(): PendingReference {
    const host = document.createElement('div');
    host.textContent = 'the referenced lines';
    document.body.appendChild(host);
    const rect = { left: 10, top: 20, right: 110, bottom: 70, width: 100, height: 50 } as DOMRect;
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect);
    return { kind: 'artifact', label: 'x', promptText: 'x', anchor: { host, range: null } };
  }

  it('stamps data-reduced="true" on the trace svg and the lift when reducedEffects is on', () => {
    localStorage.setItem(REDUCED_EFFECTS_KEY, '1'); // ThemeProvider reads this synchronously on mount (theme-context.tsx:139)
    const { unmount } = renderOverlayWithTheme(makeReferenceWithHost());
    act(() => {});

    // Travelling (chat): no source-anchored trace, but the lift is stamped.
    expect(document.querySelector('.reference-trace')).toBeNull();
    expect(document.querySelector('.reference-lift')?.getAttribute('data-reduced')).toBe('true');
    unmount();

    // Non-travelling (artifact): the trace renders and is stamped too.
    renderOverlayWithTheme(makeArtifactReferenceWithHost());
    act(() => {});
    expect(document.querySelector('.reference-trace')?.getAttribute('data-reduced')).toBe('true');
  });

  it('leaves data-reduced entirely absent (not just falsy) when reducedEffects is off', () => {
    // No localStorage write — ThemeProvider's default is reducedEffects: false.
    const { unmount } = renderOverlayWithTheme(makeReferenceWithHost());
    act(() => {});

    const lift = document.querySelector('.reference-lift');
    expect(lift).not.toBeNull();
    expect(lift?.hasAttribute('data-reduced')).toBe(false);
    unmount();

    renderOverlayWithTheme(makeArtifactReferenceWithHost());
    act(() => {});
    const trace = document.querySelector('.reference-trace');
    expect(trace).not.toBeNull();
    // hasAttribute, not a falsy getAttribute check: React only omits the DOM
    // attribute entirely when the prop value is `undefined`, and globals.css's
    // `[data-reduced="true"]` attribute selector cares about presence, not
    // truthiness — `data-reduced="false"` would still (wrongly) not match
    // this selector but WOULD show up in the DOM, which is a different bug
    // than what this test is pinning.
    expect(trace?.hasAttribute('data-reduced')).toBe(false);
  });
});

// Issues A/B (final review): detached source. Reachable two ways — a session
// switch away-and-back restores a PARKED reference (reference-context.tsx)
// whose original message DOM was replaced meanwhile by ChatView, or an
// artifact reference's file tab is switched/closed while the reference stays
// held. `reference.anchor.host` is a real Element object in both cases (never
// null) but `.isConnected` is false. Before the fix, both positioning
// effects called `src.getBoundingClientRect()` unconditionally, which
// returns an all-zero rect for a disconnected element — landing the card
// pinned in the viewport's top-left corner (chat: zero-width FLIP source;
// artifact: pinned at (0,0) with no clip, showing the whole unclipped file).
// Spec §7 requires a non-anchored, CENTRED card instead. These tests fail
// against the pre-fix code because the pre-fix left/top/transform come out
// as the zero-rect values ('0px' / 'translate(0, 0)'-derived), not '50%' /
// 'translate(-50%, -50%)'.
describe('detached source (Issues A/B: final review)', () => {
  // Round-trips the host through the document rather than never attaching it
  // at all, matching the REAL scenario the bug report describes — a host
  // that WAS in the document and got torn out from under a parked reference
  // — not a host that was never attached in the first place.
  function makeDetachedHost(text: string): HTMLElement {
    const host = document.createElement('div');
    host.textContent = text;
    document.body.appendChild(host);
    document.body.removeChild(host);
    return host;
  }

  it('chat reference: renders a centred, non-animated card instead of a zero-rect corner pin', () => {
    const host = makeDetachedHost('a message that no longer has a DOM home');
    expect(host.isConnected).toBe(false);

    renderOverlay({
      kind: 'chat-text',
      label: 'x',
      promptText: 'x',
      anchor: { host, range: null },
    });
    act(() => {});

    const lift = document.querySelector('.reference-lift') as HTMLElement;
    expect(lift).not.toBeNull();
    expect(lift.getAttribute('data-detached')).toBe('true');
    expect(lift.style.left).toBe('50%');
    expect(lift.style.top).toBe('50%');
    expect(lift.style.transform).toBe('translate(-50%, -50%)');
    expect(lift.style.clipPath).toBe('none');

    // The clone itself is still valid — captured once at reference-creation
    // time, independent of the source's later connectivity — so there is
    // still content to show; only the positioning inputs were gone.
    const clone = document.querySelector('.reference-lift-card')?.firstElementChild;
    expect(clone).not.toBeNull();
    expect(clone?.textContent).toBe('a message that no longer has a DOM home');
  });

  it('artifact reference: renders the same centred, unclipped card, not pinned at (0,0)', () => {
    const host = makeDetachedHost('const x = 1;');
    expect(host.isConnected).toBe(false);

    renderOverlay({
      kind: 'artifact',
      label: 'lines 1-1 of x.ts',
      promptText: 'x',
      anchor: { host, range: null },
    });
    act(() => {});

    const lift = document.querySelector('.reference-lift') as HTMLElement;
    expect(lift).not.toBeNull();
    expect(lift.hasAttribute('data-travels')).toBe(false); // sanity: still an artifact kind
    expect(lift.getAttribute('data-detached')).toBe('true');
    expect(lift.style.left).toBe('50%');
    expect(lift.style.top).toBe('50%');
    expect(lift.style.transform).toBe('translate(-50%, -50%)');
    // No clip: there is no live selection position left to clip against.
    expect(lift.style.clipPath).toBe('none');
  });

  it('an attached reference never gets data-detached (regression guard)', () => {
    const host = document.createElement('div');
    host.textContent = 'still attached';
    document.body.appendChild(host);
    const rect = { left: 10, top: 20, right: 110, bottom: 70, width: 100, height: 50 } as DOMRect;
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect);

    renderOverlay({ kind: 'chat-text', label: 'x', promptText: 'x', anchor: { host, range: null } });
    act(() => {});

    const lift = document.querySelector('.reference-lift') as HTMLElement;
    expect(lift.hasAttribute('data-detached')).toBe(false);
    // Sanity: it took the normal attached FLIP path, not the centred one.
    expect(lift.style.left).toBe('10px');

    document.body.removeChild(host);
  });
});
