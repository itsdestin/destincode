// @vitest-environment jsdom
// Fix: pin jsdom explicitly (see ReferenceOverlay.test.tsx / use-esc-close.test.tsx
// for why) — this file lives under src/**/*.test.tsx, outside vitest.config.ts's
// tests/**/*.tsx auto-jsdom glob.
//
// Issue C (final review): "second 'Ask about this' while one is held ->
// replaces it" (spec §7) was dead for chat references. `.reference-scrim` is a
// window-wide `pointer-events: auto` layer that sits ABOVE `.chat-scroll`
// while a reference is held, so a right-click on a dimmed chat message hits
// the scrim first — and buildContextMenu's `.chat-scroll` ancestry gate then
// bails, because the scrim itself is portaled OUTSIDE `.chat-scroll`
// (ReferenceOverlay.tsx portals straight to document.body). The fix teaches
// ContextMenuHost's contextmenu handler to resolve the TRUE element under the
// pointer via `document.elementsFromPoint` whenever the raw event target is
// part of the reference overlay's chrome.
//
// jsdom does not implement `elementsFromPoint` at all (verified: it's simply
// undefined on `document`) — these tests STUB it explicitly rather than
// asserting anything about real hit-testing/paint order, which only a real
// browser can confirm. That is called out again at each stub site.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { ReferenceProvider, useReference, type PendingReference } from '../../state/reference-context';
import { ContextMenuHost } from './ContextMenuHost';

// jsdom does not implement elementsFromPoint, so the tests below install it.
// Capture whatever was there (normally nothing) and put it back after each
// test — leaving a stub on the shared `document` would change how any later
// test in the same environment feature-detects it.
const originalEFP = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint');

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  if (originalEFP) Object.defineProperty(document, 'elementsFromPoint', originalEFP);
  else delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
  vi.unstubAllGlobals();
});

// Test-only bridge so assertions can read the CURRENT held reference without
// reaching into ContextMenuHost's private state — mirrors ReferenceOverlay.
// test.tsx's SetsReference idiom, just reading instead of writing.
function ReadsReference({ onValue }: { onValue: (r: PendingReference | null) => void }) {
  const { reference } = useReference();
  onValue(reference);
  return null;
}

function renderHost() {
  let latest: PendingReference | null = null;
  const utils = render(
    <ReferenceProvider sessionId="test-session">
      <ContextMenuHost />
      <ReadsReference onValue={(r) => { latest = r; }} />
    </ReferenceProvider>,
  );
  return { ...utils, getReference: () => latest };
}

// Builds the DOM shape a held chat reference dims: a `.reference-scrim`
// portaled straight to document.body (exactly how ReferenceOverlay.tsx
// portals it — a SIBLING of the chat tree, not an ancestor of it), and a
// separate `.chat-scroll > .user-bubble` subtree underneath it in paint
// order, standing in for the real transcript still visible (dimmed) through
// the scrim.
function buildDimmedChatDom() {
  const scrim = document.createElement('div');
  scrim.className = 'reference-scrim';
  document.body.appendChild(scrim);

  const chatScroll = document.createElement('div');
  chatScroll.className = 'chat-scroll';
  const bubble = document.createElement('div');
  bubble.className = 'user-bubble';
  bubble.textContent = 'the dimmed message';
  chatScroll.appendChild(bubble);
  document.body.appendChild(chatScroll);

  return { scrim, chatScroll, bubble };
}

describe('ContextMenuHost: right-click through the reference scrim (Issue C)', () => {
  it('resolves past the scrim to the real dimmed message and opens an actionable menu', () => {
    const { scrim, bubble } = buildDimmedChatDom();

    // STUB, not a real browser hit-test: jsdom has no elementsFromPoint at
    // all. This asserts the MECHANISM (ContextMenuHost consults it and picks
    // the first non-overlay element), not real paint-order coordinates — a
    // dev-instance check is still required to confirm actual hit-testing at
    // a real (x, y).
    document.elementsFromPoint = vi.fn().mockReturnValue([scrim, bubble, document.body, document.documentElement]);

    renderHost();

    // The contextmenu event's native target is the SCRIM (what a real
    // browser would hit-test first, since it's pointer-events:auto and
    // covers the whole window) — not the bubble underneath it.
    fireEvent.contextMenu(scrim, { clientX: 40, clientY: 60 });

    expect(document.elementsFromPoint).toHaveBeenCalledWith(40, 60);
    // Before the fix this menu never opens: buildContextMenu(scrim, ...)
    // bails at the `.chat-scroll` gate because the scrim is portaled outside
    // `.chat-scroll` entirely.
    // getByRole throws if not found — this project has no jest-dom matchers
    // registered (see other test files: they assert with .not.toBeNull(),
    // not .toBeInTheDocument()), so the presence check IS the throw-or-not.
    expect(screen.getByRole('menuitem', { name: 'Ask about this' })).not.toBeNull();
  });

  it('running "Ask about this" resolved through the scrim replaces the held reference', () => {
    const { scrim, bubble } = buildDimmedChatDom();
    document.elementsFromPoint = vi.fn().mockReturnValue([scrim, bubble, document.body, document.documentElement]);

    const initial: PendingReference = {
      kind: 'chat-text',
      label: 'the FIRST held reference',
      promptText: 'x',
      anchor: null,
    };

    // Object wrapper, not a bare `let`: TS 5.9.3 narrows a `let` that is only
    // ever reassigned inside a closure to `never` at later property reads
    // (TS2339). Same workaround the context-menu tests already use.
    const seen: { current: PendingReference | null } = { current: null };
    render(
      <ReferenceProvider sessionId="test-session">
        <ContextMenuHost />
        <ReadsReference onValue={(r) => { seen.current = r; }} />
        <SetsInitial value={initial} />
      </ReferenceProvider>,
    );
    expect(seen.current).toBe(initial);

    fireEvent.contextMenu(scrim, { clientX: 40, clientY: 60 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ask about this' }));

    // setReference always overwrites (reference-context.tsx) — the state
    // layer already supported replacement; what was broken is that the UI
    // could never REACH it for chat. `current` is now a DIFFERENT object
    // than `initial`, built from the bubble resolved through the scrim.
    const replaced = seen.current;
    expect(replaced).not.toBeNull();
    expect(replaced).not.toBe(initial);
    expect(replaced?.label).toContain('the dimmed message');
  });

  it('does not touch elementsFromPoint at all when no reference is held (scoped fast path)', () => {
    // Deliberately NO `.reference-scrim` in the DOM and NO stub for
    // elementsFromPoint — jsdom doesn't implement it, so if the fix called it
    // unconditionally (instead of gating on "target is under the scrim"),
    // this test would throw a TypeError and fail. Passing proves the "no
    // reference held -> behave exactly as today" requirement.
    const chatScroll = document.createElement('div');
    chatScroll.className = 'chat-scroll';
    const bubble = document.createElement('div');
    bubble.className = 'user-bubble';
    bubble.textContent = 'a normal message, nothing held';
    chatScroll.appendChild(bubble);
    document.body.appendChild(chatScroll);

    renderHost();

    fireEvent.contextMenu(bubble, { clientX: 10, clientY: 10 });

    // getByRole throws if not found — this project has no jest-dom matchers
    // registered (see other test files: they assert with .not.toBeNull(),
    // not .toBeInTheDocument()), so the presence check IS the throw-or-not.
    expect(screen.getByRole('menuitem', { name: 'Ask about this' })).not.toBeNull();
  });

  it('a right-click entirely outside any overlay chrome or actionable surface still opens nothing (regression guard)', () => {
    buildDimmedChatDom(); // scrim present, but we click a target OUTSIDE it
    const plainDiv = document.createElement('div');
    document.body.appendChild(plainDiv);

    renderHost();
    fireEvent.contextMenu(plainDiv, { clientX: 5, clientY: 5 });

    expect(screen.queryByRole('menu')).toBeNull();
  });
});

// Sibling bridge for the "replaces" test above — sets its value exactly once
// on mount, same shape as ReferenceOverlay.test.tsx's SetsReference.
function SetsInitial({ value }: { value: PendingReference }) {
  const { setReference } = useReference();
  React.useEffect(() => { setReference(value); }, []);
  return null;
}
