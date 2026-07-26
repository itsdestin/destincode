// @vitest-environment jsdom
// Fix: pin jsdom explicitly (see use-esc-close.test.tsx for why) — this file
// lives under src/**/*.test.tsx, outside vitest.config.ts's tests/**/*.tsx
// auto-jsdom glob.
import React, { useEffect } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { EscCloseProvider } from '../../hooks/use-esc-close';
import { ReferenceProvider, useReference, type PendingReference } from '../../state/reference-context';
import { ReferenceOverlay } from './ReferenceOverlay';

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
