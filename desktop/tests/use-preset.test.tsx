// @vitest-environment jsdom
// Guards the native-harness preset lifecycle hook (RuntimeBinding.usePreset).
// The regression these cover is I2: the per-form copies re-armed by resetting a
// `touched` ref AND re-setting cwd to the default folder, relying on a cwd change
// to re-run a useEffect([cwd]). After the first create the folder is ALREADY the
// default, so the cwd never changed → the effect never re-ran → the user's last
// manual pick stuck across reopen. usePreset keys the re-arm on the `active`
// (form-open) false→true edge instead, so an UNCHANGED cwd can't trap it.
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePreset } from '../src/renderer/components/RuntimeBinding';

describe('usePreset', () => {
  it('(a) tracks the folder heuristic while the user has not picked', () => {
    const { result, rerender } = renderHook(
      ({ active, cwd }) => usePreset({ active, cwd }),
      { initialProps: { active: true, cwd: '' } },
    );
    // Empty folder → Assistant.
    expect(result.current.preset).toBe('assistant');
    // Folder set while untouched → tracks to Coder.
    rerender({ active: true, cwd: '/proj' });
    expect(result.current.preset).toBe('coder');
    // Cleared again while untouched → back to Assistant.
    rerender({ active: true, cwd: '' });
    expect(result.current.preset).toBe('assistant');
  });

  it('(b) a manual pick latches — the heuristic stops overriding it', () => {
    const { result, rerender } = renderHook(
      ({ active, cwd }) => usePreset({ active, cwd }),
      { initialProps: { active: true, cwd: '' } },
    );
    expect(result.current.preset).toBe('assistant');
    // User explicitly picks Coder against the empty-folder heuristic.
    act(() => result.current.setPreset('coder'));
    expect(result.current.preset).toBe('coder');
    // A later cwd change must NOT override the latched manual pick.
    rerender({ active: true, cwd: '' }); // heuristic would say 'assistant'
    expect(result.current.preset).toBe('coder');
    rerender({ active: true, cwd: '/other' });
    expect(result.current.preset).toBe('coder');
  });

  it('(c) re-arms on active false→true and re-derives from the CURRENT cwd EVEN WHEN cwd is unchanged (the I2 regression)', () => {
    // Model the exact failure: default folder → Coder; user opens, picks
    // Assistant, creates; reopens with the folder UNCHANGED.
    const { result, rerender } = renderHook(
      ({ active, cwd }) => usePreset({ active, cwd }),
      { initialProps: { active: true, cwd: '/proj' } },
    );
    // Folder set → Coder heuristic.
    expect(result.current.preset).toBe('coder');
    // User overrides to Assistant and creates.
    act(() => result.current.setPreset('assistant'));
    expect(result.current.preset).toBe('assistant');
    // Form closes on create.
    rerender({ active: false, cwd: '/proj' });
    // Form REOPENS with the SAME cwd (the trap that defeated the old copies).
    rerender({ active: true, cwd: '/proj' });
    // Must re-derive from the current folder heuristic, NOT keep the stale pick.
    expect(result.current.preset).toBe('coder');
  });

  it('(c2) re-arm also re-derives when the reopen cwd differs', () => {
    const { result, rerender } = renderHook(
      ({ active, cwd }) => usePreset({ active, cwd }),
      { initialProps: { active: true, cwd: '/proj' } },
    );
    act(() => result.current.setPreset('assistant'));
    expect(result.current.preset).toBe('assistant');
    rerender({ active: false, cwd: '/proj' });
    // Reopen with an empty folder → re-derives to Assistant (heuristic agrees,
    // but crucially the latch is dropped so a subsequent folder set tracks again).
    rerender({ active: true, cwd: '' });
    expect(result.current.preset).toBe('assistant');
    rerender({ active: true, cwd: '/proj2' });
    expect(result.current.preset).toBe('coder');
  });
});
