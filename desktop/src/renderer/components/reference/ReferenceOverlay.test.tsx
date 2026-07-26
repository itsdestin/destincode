// @vitest-environment jsdom
// Fix: pin jsdom explicitly (see use-esc-close.test.tsx for why) — this file
// lives under src/**/*.test.tsx, outside vitest.config.ts's tests/**/*.tsx
// auto-jsdom glob.
import React, { useEffect, useState } from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react';
import { EscCloseProvider, useEscClose } from '../../hooks/use-esc-close';
import { ReferenceProvider, useReference, type PendingReference } from '../../state/reference-context';
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
