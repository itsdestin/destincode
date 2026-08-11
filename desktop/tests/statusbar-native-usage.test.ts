import { describe, it, expect } from 'vitest';
import { selectNativeStatusChips } from '../src/renderer/components/StatusBar';

describe('native StatusBar chips', () => {
  it('exposes in/out/speed for the shared In:/Out:/Speed: chips', () => {
    // Native no longer renders its own Tokens/Speed chips — it feeds the chips
    // that already exist, which sat at "--" forever in native sessions because
    // only the CC statusline ever wrote them (Destin, 2026-07-28).
    const chips = selectNativeStatusChips(
      { inputTokens: 6000, outputTokens: 400, tokensPerSecond: 42, contextUsedTokens: 6400 },
      8192,
    )!;
    expect(chips.inputTokens).toBe(6000);
    expect(chips.outputTokens).toBe(400);
    expect(chips.tokensPerSecond).toBe(42);
  });

  it('null when there is no native usage yet (CC/idle sessions unaffected)', () => {
    expect(selectNativeStatusChips(undefined, 8192)).toBeNull();
  });
});

describe('native context chip — how FULL the window is', () => {
  it('measures occupancy, not the turn total', () => {
    // The distinction that matters: a 5-step turn re-sends the whole history
    // every step, so summed inputTokens is a multiple of what the model holds.
    // contextUsedTokens is the last step's prompt + its reply — the real
    // occupancy — and only it may drive the gauge.
    const chips = selectNativeStatusChips(
      { inputTokens: 30_000, outputTokens: 900, contextUsedTokens: 6_400 },
      8192,
    )!;
    expect(chips.contextUsedTokens).toBe(6_400);
    expect(chips.contextPct).toBe(22);           // (8192-6400)/8192 ≈ 22% remaining
    // Had it used the summed 30,900 it would have clamped to a flat 0%.
    expect(chips.contextPct).not.toBe(0);
  });

  it('falls back to in+out for records written before contextUsedTokens existed', () => {
    const chips = selectNativeStatusChips({ inputTokens: 6000, outputTokens: 400 }, 8192)!;
    expect(chips.contextUsedTokens).toBe(6400);
    expect(chips.contextPct).toBe(22);
  });

  it('reports a nearly-full window as nearly full', () => {
    // The regression Destin caught: the gauge read 367/128k on a session whose
    // prompt was thousands of tokens, because it was measuring one turn's
    // output rather than the conversation.
    const chips = selectNativeStatusChips(
      { inputTokens: 0, outputTokens: 367, contextUsedTokens: 120_000 },
      128_000,
    )!;
    expect(chips.contextPct).toBe(6);
    expect(chips.contextUsedTokens).toBe(120_000);
  });

  it('clamps to [0,100] rather than reporting a negative window', () => {
    const over = selectNativeStatusChips({ inputTokens: 0, outputTokens: 0, contextUsedTokens: 99_999 }, 8192)!;
    expect(over.contextPct).toBe(0);
  });

  it('never fabricates a percentage when the window size is unknown', () => {
    const chips = selectNativeStatusChips({ inputTokens: 100, outputTokens: 20, contextUsedTokens: 120 }, null)!;
    expect(chips.contextPct).toBeNull();
    expect(chips.inputTokens).toBe(100);         // the other chips still work
  });
});

// M4 Task 1 (plan: docs/active/plans/2026-08-10-m4-reliability-tranche.md).
// The In/Out and Speed chips got a `?? nativeChips` fallback on 2026-07-28; the
// two cache chips beside them did not, so they rendered '--' forever in native
// sessions while the harness shipped the numbers on every turn-complete.
describe('selectNativeStatusChips — cache fields', () => {
  it('passes cache tokens through so the Cached/Hit chips can use them', () => {
    const chips = selectNativeStatusChips(
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheCreationTokens: 100 },
      8_000,
    );
    expect(chips?.cacheReadTokens).toBe(900);
    expect(chips?.cacheCreationTokens).toBe(100);
  });

  it('reports null rather than 0 when the provider sent no cache data', () => {
    // 0 and "absent" are different facts: 0 reads is a real 0% hit rate, absent
    // must stay '--'. Collapsing them would invent a statistic.
    const chips = selectNativeStatusChips({ inputTokens: 100, outputTokens: 20 }, 8_000);
    expect(chips?.cacheReadTokens).toBeNull();
    expect(chips?.cacheCreationTokens).toBeNull();
  });

  it('keeps a real zero distinguishable from absent', () => {
    const chips = selectNativeStatusChips(
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 500 },
      8_000,
    );
    expect(chips?.cacheReadTokens).toBe(0);
  });
});
