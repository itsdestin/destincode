import { describe, it, expect } from 'vitest';
import { selectNativeStatusChips } from '../src/renderer/components/StatusBar';

describe('native StatusBar chips', () => {
  it('derives context %, total tokens, tokens/sec from a native turn-complete usage payload', () => {
    const chips = selectNativeStatusChips({ inputTokens: 6000, outputTokens: 400, tokensPerSecond: 42 }, 8192);
    expect(chips.contextPct).toBe(22);           // (8192-6400)/8192 ≈ 22% remaining
    expect(chips.tokensPerSecond).toBe(42);
    expect(chips.totalTokens).toBe(6400);
  });
  it('null when there is no native usage yet (CC/idle sessions unaffected)', () => {
    expect(selectNativeStatusChips(undefined, 8192)).toBeNull();
  });
});
