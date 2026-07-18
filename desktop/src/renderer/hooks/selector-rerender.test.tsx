// @vitest-environment jsdom
//
// Perf characterization + guard for the 2026-07-17 AppInner tranche.
//
// This is the rigorous before/after the dev-instance profiler approximates: it
// mounts, under ONE ChatProvider, a probe using the OLD whole-map subscription
// (useChatStateMap — what AppInner used to do) alongside a probe using the NEW
// cached selector (useSessionAttention — what it does now), then fires reducer
// dispatches that do NOT change any session's dot triple and counts commits.
//
// The old pattern re-renders on EVERY dispatch; the new one re-renders only
// when a derived value actually changes. That gap is the whole point of the
// tranche — during streaming, most transcript dispatches change a session's
// timeline but not its (status, attentionState, awaitingApproval) triple, so
// the new pattern skips them. If this test's gap ever collapses, the perf win
// regressed.
import React, { useEffect } from 'react';
import { describe, it, expect } from 'vitest';
import { render, act } from '@testing-library/react';
import { ChatProvider, useChatDispatch, useChatStateMap } from '../state/chat-context';
import { useSessionAttention } from './useSessionAttention';

const SESSIONS = [{ id: 's1' }];

function makeCounter() { return { commits: 0 }; }

// Counts commits via a no-dep effect (runs once per committed render).
function OldPatternProbe({ counter }: { counter: { commits: number } }) {
  useChatStateMap();                       // old: subscribes to the whole map
  useEffect(() => { counter.commits += 1; });
  return null;
}
function NewPatternProbe({ counter }: { counter: { commits: number } }) {
  useSessionAttention(SESSIONS, new Set<string>(), 's1');   // new: cached selector
  useEffect(() => { counter.commits += 1; });
  return null;
}

let capturedDispatch: ((a: any) => void) | null = null;
function DispatchCapture() {
  capturedDispatch = useChatDispatch();
  return null;
}

describe('chat-state re-render: old whole-map subscription vs new cached selector', () => {
  it('the selector skips dispatches that do not change a session dot triple', () => {
    const oldC = makeCounter();
    const newC = makeCounter();
    capturedDispatch = null;

    render(
      <ChatProvider>
        <DispatchCapture />
        <OldPatternProbe counter={oldC} />
        <NewPatternProbe counter={newC} />
      </ChatProvider>,
    );
    const dispatch = capturedDispatch!;

    // Bring s1 to a steady "thinking / green dot" state. Both probes commit for
    // these because the triple genuinely changes (absent → gray → green).
    act(() => { dispatch({ type: 'SESSION_INIT', sessionId: 's1' }); });
    act(() => { dispatch({ type: 'USER_PROMPT', sessionId: 's1', content: 'go', timestamp: 1 }); });

    const oldBaseline = oldC.commits;
    const newBaseline = newC.commits;

    // Now fire 5 dispatches that each change s1's chat state (new session object,
    // growing timeline) but NOT its dot triple: another user prompt while it's
    // already thinking. isThinking stays true → status stays green, attention
    // stays ok, no tools awaiting → the (status, attentionState, awaitingApproval)
    // triple is identical, so the selector returns the SAME Map reference.
    const NOOP_TRIPLE_DISPATCHES = 5;
    for (let i = 0; i < NOOP_TRIPLE_DISPATCHES; i++) {
      act(() => { dispatch({ type: 'USER_PROMPT', sessionId: 's1', content: `again ${i}`, timestamp: 10 + i }); });
    }

    const oldDelta = oldC.commits - oldBaseline;
    const newDelta = newC.commits - newBaseline;

    // The old whole-map subscriber committed once per dispatch.
    expect(oldDelta).toBe(NOOP_TRIPLE_DISPATCHES);
    // The cached selector committed ZERO extra times — the whole point.
    expect(newDelta).toBe(0);
  });

  it('the selector DOES re-render when a dispatch changes the dot triple', () => {
    const newC = makeCounter();
    capturedDispatch = null;

    render(
      <ChatProvider>
        <DispatchCapture />
        <NewPatternProbe counter={newC} />
      </ChatProvider>,
    );
    const dispatch = capturedDispatch!;

    act(() => { dispatch({ type: 'SESSION_INIT', sessionId: 's1' }); });   // → gray
    const afterInit = newC.commits;
    act(() => { dispatch({ type: 'USER_PROMPT', sessionId: 's1', content: 'go', timestamp: 1 }); }); // gray → green
    // A real triple change (gray → green) MUST commit, or the dots would freeze.
    expect(newC.commits).toBeGreaterThan(afterInit);
  });
});
