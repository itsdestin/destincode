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
  // window event carries no session id. Mount two — one visible, one not —
  // and fire a single event. Only the visible session's dispatch is the
  // control that proves the fix does something; the background session
  // dispatching nothing is the actual regression check.
  it('only the visible session responds when two sessions are mounted at once', () => {
    const dispatchFocused = vi.fn();
    const dispatchBackground = vi.fn();
    renderHook(() => useSessionPreviewListener('focused', true, dispatchFocused));
    renderHook(() => useSessionPreviewListener('background', false, dispatchBackground));

    window.dispatchEvent(new CustomEvent('youcoded:preview-session', { detail: { provider: 'claude', id: 'abc', title: 'T' } }));

    // Positive control: the focused/visible session did respond.
    expect(dispatchFocused).toHaveBeenCalledTimes(2);
    expect(dispatchFocused.mock.calls[1][0]).toEqual({ type: 'SESSION_PREVIEW_SET', sessionId: 'focused', provider: 'claude', id: 'abc', title: 'T' });
    // The actual regression check: the background session dispatched nothing at all.
    expect(dispatchBackground).not.toHaveBeenCalled();
  });
});
