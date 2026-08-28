// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSessionPreviewListener } from '../src/renderer/hooks/useSessionPreviewListener';

vi.mock('../src/renderer/components/artifact-views/dirty-editor-guard', () => ({ guardDirtyEditor: (a: () => void) => a() }));

describe('useSessionPreviewListener', () => {
  it('turns the preview event into SESSION_REFERENCED + SESSION_PREVIEW_SET for its session', () => {
    const dispatch = vi.fn();
    renderHook(() => useSessionPreviewListener('s1', true, dispatch));
    window.dispatchEvent(new CustomEvent('youcoded:preview-session', { detail: { provider: 'claude', id: 'abc', title: 'T' } }));
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ type: 'SESSION_REFERENCED', sessionId: 's1', ref: { provider: 'claude', id: 'abc', title: 'T' } });
    expect(dispatch.mock.calls[1][0]).toEqual({ type: 'SESSION_PREVIEW_SET', sessionId: 's1', provider: 'claude', id: 'abc', title: 'T' });
  });
  it('stops listening on unmount', () => {
    const dispatch = vi.fn();
    const { unmount } = renderHook(() => useSessionPreviewListener('s1', true, dispatch));
    unmount();
    window.dispatchEvent(new CustomEvent('youcoded:preview-session', { detail: { provider: 'claude', id: 'abc', title: 'T' } }));
    expect(dispatch).not.toHaveBeenCalled();
  });

  // Pins the actual bug: App.tsx mounts one ChatView (and therefore one copy
  // of this hook) per OPEN SESSION TAB, background tabs included, and the
  // window event carries no session id. Mount two — one active, one not —
  // and fire a single event. Only the active session's dispatch is the
  // control that proves the fix does something; the background session
  // dispatching nothing is the actual regression check.
  it('only the active session responds when two sessions are mounted at once', () => {
    const dispatchActive = vi.fn();
    const dispatchBackground = vi.fn();
    renderHook(() => useSessionPreviewListener('focused', true, dispatchActive));
    renderHook(() => useSessionPreviewListener('background', false, dispatchBackground));

    window.dispatchEvent(new CustomEvent('youcoded:preview-session', { detail: { provider: 'claude', id: 'abc', title: 'T' } }));

    // Positive control: the active session did respond.
    expect(dispatchActive).toHaveBeenCalledTimes(2);
    expect(dispatchActive.mock.calls[1][0]).toEqual({ type: 'SESSION_PREVIEW_SET', sessionId: 'focused', provider: 'claude', id: 'abc', title: 'T' });
    // The actual regression check: the background session dispatched nothing at all.
    expect(dispatchBackground).not.toHaveBeenCalled();
  });

  // Pins the hardening: the gate is `sessionActive` (App.tsx: s.id === sessionId),
  // NOT `visible` (App.tsx: s.id === sessionId && viewMode === 'chat'). A session
  // can be the active one while its tab is on Terminal — e.g. TerminalRightSlot
  // renders SessionDrawer alongside the terminal, where a Preview click would
  // reach this hook with sessionActive=true but would have had visible=false
  // under the old gate. That session must still respond; a truly different
  // (non-active) background session must still not.
  it('the active session responds even on the terminal tab; a non-active session does not', () => {
    const dispatchActiveOnTerminal = vi.fn();
    const dispatchBackground = vi.fn();
    // sessionActive=true simulates "this session is the open tab, currently
    // viewing Terminal" — visible would be false here, sessionActive is not.
    renderHook(() => useSessionPreviewListener('active-on-terminal', true, dispatchActiveOnTerminal));
    renderHook(() => useSessionPreviewListener('background', false, dispatchBackground));

    window.dispatchEvent(new CustomEvent('youcoded:preview-session', { detail: { provider: 'claude', id: 'abc', title: 'T' } }));

    expect(dispatchActiveOnTerminal).toHaveBeenCalledTimes(2);
    expect(dispatchActiveOnTerminal.mock.calls[1][0]).toEqual({ type: 'SESSION_PREVIEW_SET', sessionId: 'active-on-terminal', provider: 'claude', id: 'abc', title: 'T' });
    expect(dispatchBackground).not.toHaveBeenCalled();
  });
});
