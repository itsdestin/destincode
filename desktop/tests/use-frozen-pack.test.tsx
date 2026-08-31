// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFrozenPack } from '../src/renderer/components/header/use-frozen-pack';
import type { PackResult } from '../src/renderer/components/header/pack-sessions';

const pack = (expanded: string[], collapsed: string[] = [], overflow: string[] = []): PackResult =>
  ({ expanded: new Set(expanded), collapsed, overflow });

describe('useFrozenPack', () => {
  it('passes the live pack through when not frozen', () => {
    const { result, rerender } = renderHook(
      ({ p, f }) => useFrozenPack(p, f),
      { initialProps: { p: pack(['a']), f: false } },
    );
    expect([...result.current.expanded]).toEqual(['a']);
    rerender({ p: pack(['a', 'b']), f: false });
    expect([...result.current.expanded]).toEqual(['a', 'b']);
  });

  it('holds the pack captured at the moment it froze', () => {
    // The drag case: opening a slot makes the row wider, which can trip a
    // repack. Pills turning into dots mid-drag would be worse than the jump
    // this whole feature exists to remove.
    const { result, rerender } = renderHook(
      ({ p, f }) => useFrozenPack(p, f),
      { initialProps: { p: pack(['a', 'b']), f: false } },
    );
    rerender({ p: pack(['a', 'b']), f: true });
    rerender({ p: pack(['a']), f: true });          // packer wants to collapse b
    expect([...result.current.expanded]).toEqual(['a', 'b']);
  });

  it('releases to the live pack when it unfreezes', () => {
    const { result, rerender } = renderHook(
      ({ p, f }) => useFrozenPack(p, f),
      { initialProps: { p: pack(['a', 'b']), f: true } },
    );
    rerender({ p: pack(['a']), f: true });
    expect([...result.current.expanded]).toEqual(['a', 'b']);
    rerender({ p: pack(['a']), f: false });
    expect([...result.current.expanded]).toEqual(['a']);
  });
});
