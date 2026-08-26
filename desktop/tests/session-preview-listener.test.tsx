// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSessionPreviewListener } from '../src/renderer/hooks/useSessionPreviewListener';

vi.mock('../src/renderer/components/artifact-views/dirty-editor-guard', () => ({ guardDirtyEditor: (a: () => void) => a() }));

describe('useSessionPreviewListener', () => {
  it('turns the preview event into SESSION_REFERENCED + SESSION_PREVIEW_SET for its session', () => {
    const dispatch = vi.fn();
    renderHook(() => useSessionPreviewListener('s1', dispatch));
    window.dispatchEvent(new CustomEvent('youcoded:preview-session', { detail: { provider: 'claude', id: 'abc', title: 'T' } }));
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ type: 'SESSION_REFERENCED', sessionId: 's1', ref: { provider: 'claude', id: 'abc', title: 'T' } });
    expect(dispatch.mock.calls[1][0]).toEqual({ type: 'SESSION_PREVIEW_SET', sessionId: 's1', provider: 'claude', id: 'abc', title: 'T' });
  });
  it('stops listening on unmount', () => {
    const dispatch = vi.fn();
    const { unmount } = renderHook(() => useSessionPreviewListener('s1', dispatch));
    unmount();
    window.dispatchEvent(new CustomEvent('youcoded:preview-session', { detail: { provider: 'claude', id: 'abc', title: 'T' } }));
    expect(dispatch).not.toHaveBeenCalled();
  });
});
