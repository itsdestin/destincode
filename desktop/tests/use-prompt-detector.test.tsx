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
  useChatStateMap: () => new Map(),
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
