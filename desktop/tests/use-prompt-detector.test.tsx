// @vitest-environment jsdom
// Regression tests for usePromptDetector's prompt lifecycle (2026-07-16).
//
// Bug: when a recognized setup prompt (e.g. "Resume Session") was showing and
// the PTY screen then advanced to a DIFFERENT menu, the detector overwrote its
// lastMenuRef tracking id BEFORE the SETUP_PROMPT_TITLES gate bailed out — so
// the old prompt's DISMISS_PROMPT never fired (dismissal only targets whatever
// id the ref currently points at). The orphaned timeline entry stayed at
// completed:false forever and hasPendingInteraction() blocked all sends.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  callbacks: [] as Array<(sid: string) => void>,
  screen: { text: '' },
  // Minimal ChatStore stand-in (tranche 1: the detector reads the store
  // directly instead of subscribing to the whole chat map). Most tests in
  // this file drive the detector purely through terminal buffer events with
  // an empty `sessions` map (no awaiting-approval tools), so nothing ever
  // notifies. The §2 resolver tests below populate `sessions` per-test.
  // Identity is stable across renders, matching the real store's
  // per-provider lifetime.
  sessions: new Map<string, any>(),
  store: {
    getState: () => mocks.sessions,
    subscribeAll: () => () => {},
  },
}));

vi.mock('../src/renderer/hooks/terminal-registry', () => ({
  onBufferReady: (cb: (sid: string) => void) => {
    mocks.callbacks.push(cb);
    return () => {
      const i = mocks.callbacks.indexOf(cb);
      if (i >= 0) mocks.callbacks.splice(i, 1);
    };
  },
  getVisibleScreenText: () => mocks.screen.text,
}));

vi.mock('../src/renderer/state/chat-context', () => ({
  useChatDispatch: () => mocks.dispatch,
  useChatStore: () => mocks.store,
}));

import { usePromptDetector } from '../src/renderer/hooks/usePromptDetector';

// A recognized setup prompt (title in SETUP_PROMPT_TITLES).
const RESUME_MENU = `Resume Session

1: as is
  ❯ 2: from summary

press enter to confirm`;

// A different menu the detector does NOT recognize as a setup prompt.
const UNRECOGNIZED_MENU = `Pick a flavor

 ❯ 1. Vanilla
   2. Chocolate`;

function fireBuffer(sid: string) {
  act(() => {
    for (const cb of [...mocks.callbacks]) cb(sid);
  });
}

describe('usePromptDetector prompt lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.dispatch.mockClear();
    mocks.callbacks.length = 0;
    mocks.screen.text = '';
    mocks.sessions.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a recognized setup prompt after the debounce', () => {
    renderHook(() => usePromptDetector());
    mocks.screen.text = RESUME_MENU;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(400); });

    const show = mocks.dispatch.mock.calls.find((c) => c[0].type === 'SHOW_PROMPT');
    expect(show).toBeTruthy();
    expect(show![0].title).toBe('Resume Session');
  });

  it('dismisses the previous prompt when a different, unrecognized menu replaces it', () => {
    renderHook(() => usePromptDetector());

    // Step 1: recognized prompt appears and is shown.
    mocks.screen.text = RESUME_MENU;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(400); });
    const show = mocks.dispatch.mock.calls.find((c) => c[0].type === 'SHOW_PROMPT');
    expect(show).toBeTruthy();
    const shownId = show![0].promptId as string;

    // Step 2: the PTY advances to a different, unrecognized menu.
    mocks.dispatch.mockClear();
    mocks.screen.text = UNRECOGNIZED_MENU;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(700); }); // > DISMISS_DEBOUNCE_MS

    // The old prompt must be dismissed — otherwise it orphans at
    // completed:false and hasPendingInteraction() blocks sends forever.
    const dismiss = mocks.dispatch.mock.calls.find((c) => c[0].type === 'DISMISS_PROMPT');
    expect(dismiss).toBeTruthy();
    expect(dismiss![0].promptId).toBe(shownId);

    // And the unrecognized menu must NOT produce a SHOW_PROMPT.
    const strayShow = mocks.dispatch.mock.calls.find((c) => c[0].type === 'SHOW_PROMPT');
    expect(strayShow).toBeUndefined();
  });

  it('cancels a pending (not yet shown) prompt when a different menu replaces it', () => {
    renderHook(() => usePromptDetector());

    // Recognized menu appears but the debounce has NOT elapsed yet.
    mocks.screen.text = RESUME_MENU;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(100); }); // < PROMPT_DEBOUNCE_MS

    // Screen advances to an unrecognized menu before the show fired.
    mocks.screen.text = UNRECOGNIZED_MENU;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(1000); });

    // The stale pending show must never fire.
    const show = mocks.dispatch.mock.calls.find((c) => c[0].type === 'SHOW_PROMPT');
    expect(show).toBeUndefined();
  });

  it('dispatches nothing while unrecognized menus churn (streaming numbered lists)', () => {
    renderHook(() => usePromptDetector());

    // Streaming output that happens to parse as menus, with changing ids —
    // up to ~60 buffer flushes/sec. No prompt was ever shown, so no reducer
    // dispatches should occur at all.
    mocks.screen.text = UNRECOGNIZED_MENU;
    fireBuffer('s1');
    mocks.screen.text = `Pick a size

 ❯ 1. Small
   2. Large`;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(1000); });

    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('does NOT show a prompt if the menu vanished during the debounce with no trailing flush', () => {
    // Regression (2026-07-17): the show timer captured `menu` at schedule time
    // and dispatched SHOW_PROMPT without re-checking the screen. If the PTY
    // advanced past the menu during the 350ms debounce and then went IDLE (no
    // further buffer flush to run the disappear branch), a completed:false
    // prompt entry stranded with nothing on screen — locking every send.
    renderHook(() => usePromptDetector());

    // Recognized menu appears, scheduling the show timer.
    mocks.screen.text = RESUME_MENU;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(100); }); // < PROMPT_DEBOUNCE_MS

    // The menu left the screen, but NO further buffer flush fires (idle PTY).
    mocks.screen.text = 'plain output, no menu here';

    // Let the show timer fire. Its re-check must see the menu is gone and bail.
    act(() => { vi.advanceTimersByTime(400); });

    const show = mocks.dispatch.mock.calls.find((c) => c[0].type === 'SHOW_PROMPT');
    expect(show).toBeUndefined();
  });

  it('still dismisses when the menu disappears entirely (existing behavior)', () => {
    renderHook(() => usePromptDetector());
    mocks.screen.text = RESUME_MENU;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(400); });
    const show = mocks.dispatch.mock.calls.find((c) => c[0].type === 'SHOW_PROMPT');
    const shownId = show![0].promptId as string;

    mocks.dispatch.mockClear();
    mocks.screen.text = 'plain output, no menu here';
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(700); });

    const dismiss = mocks.dispatch.mock.calls.find((c) => c[0].type === 'DISMISS_PROMPT');
    expect(dismiss).toBeTruthy();
    expect(dismiss![0].promptId).toBe(shownId);
  });
});

// Coverage for the §2 standing rule (2026-07-30 spec): usePromptDetector is
// the ONLY thing that auto-resolves a 'hook-closed'-retained card. Before
// this block, only the pure helpers in expired-card-resolver.ts had tests —
// deleting the resolver block inside usePromptDetector (the effect body that
// calls expiredToolIds/nextAbsentCount and dispatches PERMISSION_CARD_RESOLVED)
// left the whole suite green while every retained card stayed stuck until the
// user clicked Dismiss by hand.
describe('usePromptDetector — expired card resolver (2026-07-30 spec §2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.dispatch.mockClear();
    mocks.callbacks.length = 0;
    mocks.screen.text = '';
    mocks.sessions.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // A neutral, unrecognized Ink menu — parses as "a menu is present" without
  // matching any SETUP_PROMPT_TITLES entry, so it can't also trigger a
  // SHOW_PROMPT dispatch and muddy the PERMISSION_CARD_RESOLVED assertions.
  const NEUTRAL_MENU = `Pick a flavor

 ❯ 1. Vanilla
   2. Chocolate`;
  const NO_MENU = 'plain output, no menu here';

  function makeSession(tools: Array<Record<string, any>>) {
    const toolCalls = new Map(tools.map((t) => [t.toolUseId, { input: {}, ...t }]));
    return {
      toolCalls,
      activeTurnToolIds: new Set(tools.map((t) => t.toolUseId)),
    };
  }

  function setExpiredCard() {
    mocks.sessions.set('s1', makeSession([
      { toolUseId: 'toolu_expired', toolName: 'Bash', status: 'awaiting-approval', expired: true },
    ]));
  }

  it('menu present: does not resolve, and resets the absence counter', () => {
    setExpiredCard();
    renderHook(() => usePromptDetector());

    // Build up one absent flush first...
    mocks.screen.text = NO_MENU;
    fireBuffer('s1');
    // ...then the menu reappears, which must reset the counter to 0.
    mocks.screen.text = NEUTRAL_MENU;
    fireBuffer('s1');
    expect(
      mocks.dispatch.mock.calls.find((c) => c[0].type === 'PERMISSION_CARD_RESOLVED'),
    ).toBeUndefined();

    // If the reset above didn't happen, this single absent flush would be
    // the "2nd" and would wrongly resolve.
    mocks.screen.text = NO_MENU;
    fireBuffer('s1');
    expect(
      mocks.dispatch.mock.calls.find((c) => c[0].type === 'PERMISSION_CARD_RESOLVED'),
    ).toBeUndefined();
  });

  it('menu absent for ONE flush: still does not resolve', () => {
    setExpiredCard();
    renderHook(() => usePromptDetector());

    mocks.screen.text = NO_MENU;
    fireBuffer('s1');

    expect(
      mocks.dispatch.mock.calls.find((c) => c[0].type === 'PERMISSION_CARD_RESOLVED'),
    ).toBeUndefined();
  });

  it('menu absent for TWO consecutive flushes: dispatches PERMISSION_CARD_RESOLVED for the expired card', () => {
    setExpiredCard();
    renderHook(() => usePromptDetector());

    mocks.screen.text = NO_MENU;
    fireBuffer('s1');
    fireBuffer('s1');

    const resolved = mocks.dispatch.mock.calls.find((c) => c[0].type === 'PERMISSION_CARD_RESOLVED');
    expect(resolved).toBeTruthy();
    expect(resolved![0]).toMatchObject({
      type: 'PERMISSION_CARD_RESOLVED',
      sessionId: 's1',
      toolUseId: 'toolu_expired',
    });
  });

  it('a LIVE (non-expired) awaiting-approval card still bails prompt detection, unaffected by the resolver', () => {
    mocks.sessions.set('s1', makeSession([
      { toolUseId: 'toolu_live', toolName: 'Bash', status: 'awaiting-approval' },
    ]));
    renderHook(() => usePromptDetector());

    // A recognized setup-prompt menu would normally SHOW_PROMPT after the
    // debounce — the live awaiting-approval bail must suppress that too.
    mocks.screen.text = RESUME_MENU;
    fireBuffer('s1');
    act(() => { vi.advanceTimersByTime(400); });

    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
