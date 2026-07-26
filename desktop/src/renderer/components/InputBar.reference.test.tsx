// @vitest-environment jsdom
// Pins the two composer contracts of the held reference (spec 2026-07-26 §3.5):
//  1. the placeholder announces the reference, and
//  2. promptText is prepended EXACTLY ONCE at send, then the reference clears —
//     while the user's own draft is never touched by a cancel.
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, act } from '@testing-library/react';
import { ReferenceProvider, useReference, type PendingReference } from '../state/reference-context';
import { composeOutgoing, placeholderFor } from './InputBar';

const REF: PendingReference = {
  kind: 'chat-text',
  label: '"the reducer preserves…"',
  promptText: 'In an earlier message, you said:\n"x"\n\nThe user has a follow-up: ',
  anchor: null,
};

describe('placeholderFor', () => {
  it('falls back to the default with no reference', () => {
    expect(placeholderFor(null, false)).toBe('Message Claude...');
  });

  it('announces the held reference', () => {
    expect(placeholderFor(REF, false)).toBe('Ask Claude about "the reducer preserves…"');
  });

  it('the approval gate still wins over a held reference', () => {
    expect(placeholderFor(REF, true)).toBe('Waiting for approval...');
  });
});

describe('composeOutgoing', () => {
  it('returns the draft unchanged with no reference', () => {
    expect(composeOutgoing('why?', null)).toBe('why?');
  });

  it('prepends promptText exactly once', () => {
    expect(composeOutgoing('why?', REF)).toBe(REF.promptText + 'why?');
  });

  it('sends the scaffold alone when the draft is empty', () => {
    expect(composeOutgoing('', REF)).toBe(REF.promptText);
  });
});

// Hoisted to module scope (matches reference-context.test.tsx's Probe idiom):
// tsc's definite-assignment check only exempts USAGE inside a nested closure
// (e.g. act(() => api.foo())) — a direct `expect(api.reference)` in the SAME
// scope as a local `let api` declaration still trips TS2454 "used before
// being assigned", even though render() has synchronously run Probe by then.
let api: ReturnType<typeof useReference>;
function Probe() { api = useReference(); return null; }

describe('cancel does not touch the draft', () => {
  it('clearReference leaves composer state alone', () => {
    render(<ReferenceProvider sessionId="s1"><Probe /></ReferenceProvider>);
    act(() => api.setReference(REF));
    act(() => api.clearReference());
    // The context owns ONLY the reference — it has no draft to clobber.
    expect(api.reference).toBeNull();
  });
});
