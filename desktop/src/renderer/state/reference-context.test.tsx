// @vitest-environment jsdom
// Pins the per-session parking contract: a held reference belongs to the session
// it was created in, exactly like InputBar's draftsRef (InputBar.tsx:132). Switching
// away must NOT leak the reference into another session's composer, and switching
// back must restore it.
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, act } from '@testing-library/react';
import { ReferenceProvider, useReference, type PendingReference } from './reference-context';

const REF_A: PendingReference = {
  kind: 'chat-text', label: '"alpha"', promptText: 'Regarding alpha:\n', anchor: null,
};
const REF_B: PendingReference = {
  kind: 'artifact', label: 'lines 1-2 of x.ts', promptText: 'Referencing x.ts:\n', anchor: null,
};

let api: ReturnType<typeof useReference>;
function Probe() {
  api = useReference();
  return null;
}
function Harness({ sessionId }: { sessionId: string }) {
  return (
    <ReferenceProvider sessionId={sessionId}>
      <Probe />
    </ReferenceProvider>
  );
}

describe('reference-context', () => {
  it('starts with no reference', () => {
    render(<Harness sessionId="s1" />);
    expect(api.reference).toBeNull();
  });

  it('holds a reference that was set', () => {
    render(<Harness sessionId="s1" />);
    act(() => api.setReference(REF_A));
    expect(api.reference).toEqual(REF_A);
  });

  it('clearReference empties it', () => {
    render(<Harness sessionId="s1" />);
    act(() => api.setReference(REF_A));
    act(() => api.clearReference());
    expect(api.reference).toBeNull();
  });

  it('setting a second reference REPLACES the first (no multi-reference in v1)', () => {
    render(<Harness sessionId="s1" />);
    act(() => api.setReference(REF_A));
    act(() => api.setReference(REF_B));
    expect(api.reference).toEqual(REF_B);
  });

  it('parks the reference per session and restores it on return', () => {
    const { rerender } = render(<Harness sessionId="s1" />);
    act(() => api.setReference(REF_A));

    rerender(<Harness sessionId="s2" />);
    expect(api.reference).toBeNull();          // s2 must not inherit s1's reference

    act(() => api.setReference(REF_B));
    rerender(<Harness sessionId="s1" />);
    expect(api.reference).toEqual(REF_A);      // s1's is restored

    rerender(<Harness sessionId="s2" />);
    expect(api.reference).toEqual(REF_B);      // s2's is still there
  });
});
