import { describe, it, expect } from 'vitest';
import { clampContextWindow } from '../src/main/engine/engine-manager';

describe('clampContextWindow', () => {
  it('uses the min of loaded and trained max', () => {
    expect(clampContextWindow(32_768, 131_072)).toBe(32_768);
    expect(clampContextWindow(131_072, 32_768)).toBe(32_768);
  });
  it('falls back to loaded when trained is unknown, and to a conservative default when both unknown', () => {
    expect(clampContextWindow(16_384, null)).toBe(16_384);
    expect(clampContextWindow(null, null)).toBe(32_768);
  });
});
