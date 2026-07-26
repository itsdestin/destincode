// @vitest-environment jsdom
// Fix: pin jsdom explicitly (see use-esc-close.test.tsx for why) — this file
// lives under src/**/*.test.tsx, outside vitest.config.ts's tests/**/*.tsx
// auto-jsdom glob.
import React, { useEffect, useState } from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react';
import { EscCloseProvider, useEscClose } from '../../hooks/use-esc-close';
import { ReferenceProvider, useReference, type PendingReference } from '../../state/reference-context';
import { ReferenceOverlay } from './ReferenceOverlay';
import { REFERENCE_COMPOSER_Z } from '../overlays/Overlay';

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
