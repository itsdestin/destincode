import { describe, it, expect } from 'vitest';
import {
  selectNativeStatusChips,
  selectCacheReuse,
  selectReuseDisplay,
  type NativeStatusChips,
} from '../src/renderer/components/StatusBar';

describe('native StatusBar chips', () => {
  it('exposes in/out/speed for the shared In:/Out:/Speed: chips', () => {
    // Native no longer renders its own Tokens/Speed chips — it feeds the chips
    // that already exist, which sat at "--" forever in native sessions because
    // only the CC statusline ever wrote them (Destin, 2026-07-28).
    //
    // Update (task 7, spec §6): this still pins the pure selector's output —
    // in/out/speed for the LAST completed turn — but the In/Out chips in
    // StatusBar.tsx no longer read `chips.inputTokens`/`chips.outputTokens`.
    // They now read `nativeTotals` (session-so-far totals) so the same label
    // doesn't mean "one turn" in a native session and "the whole session" in a
    // Claude Code one. Speed is the one label that's still deliberately a
    // per-turn measurement in both runtimes, so it still reads this selector's
    // `tokensPerSecond` — see the speedTokPerSec comment in StatusBar.tsx.
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

// 2026-08-16. The chip used to compute reads/(reads+writes) — a "hit rate" that
// only means anything where cache WRITES are billed. Every native provider here
// (OpenRouter's models, local llama.cpp) caches automatically and reports no
// write count, so the ratio was reads/reads and the chip read 100% forever.
// Ground truth: cacheCreationTokens was 0 across all 507 recorded turns.
describe('selectCacheReuse — the fraction of the prompt served from cache', () => {
  const native = (o: Partial<NativeStatusChips>): NativeStatusChips => ({
    contextPct: null, contextUsedTokens: 0, inputTokens: 0, outputTokens: 0,
    tokensPerSecond: 0, cacheReadTokens: null, cacheCreationTokens: null, ...o,
  });

  it('does NOT return 100% when the provider reports no cache writes', () => {
    // The exact shape that pinned the old chip: real reads, zero writes.
    const reuse = selectCacheReuse(null, native({ inputTokens: 331_432, cacheReadTokens: 327_168, cacheCreationTokens: 0 }));
    expect(Math.round(reuse.ratio! * 100)).toBe(99);
    expect(reuse.ratio).not.toBe(1);
  });

  it('treats the native inputTokens as the WHOLE prompt, reads included', () => {
    // An OpenAI-compatible provider's prompt_tokens already contains the cached
    // reads. Adding them again would halve the answer — the bug that made the
    // per-turn strip show 49% for a turn that reused 98.7%.
    const reuse = selectCacheReuse(null, native({ inputTokens: 1000, cacheReadTokens: 900, cacheCreationTokens: 0 }));
    expect(reuse.promptTokens).toBe(1000);
    expect(reuse.ratio).toBeCloseTo(0.9);
  });

  it("adds reads and writes back for Claude Code's Anthropic accounting", () => {
    // Anthropic's input_tokens is the UNCACHED REMAINDER, so the prompt total is
    // input + read + create. Using the native rule here would report 100%.
    const reuse = selectCacheReuse(
      { inputTokens: 100, cacheReadTokens: 800, cacheCreationTokens: 100 },
      null,
    );
    expect(reuse.promptTokens).toBe(1000);
    expect(reuse.ratio).toBeCloseTo(0.8);
  });

  it('never mixes a numerator and denominator from different sources', () => {
    // CC wins on cache numbers, so its inputTokens must win too — reading 900
    // against the native 50_000 would report a wrong, tiny percentage.
    const reuse = selectCacheReuse(
      { inputTokens: 100, cacheReadTokens: 900, cacheCreationTokens: 0 },
      native({ inputTokens: 50_000, cacheReadTokens: 10, cacheCreationTokens: 0 }),
    );
    expect(reuse.promptTokens).toBe(1000);
    expect(reuse.readTokens).toBe(900);
  });

  it('stays null when nothing reported cache data (chip shows --)', () => {
    expect(selectCacheReuse(null, native({ inputTokens: 500 })).ratio).toBeNull();
    expect(selectCacheReuse(null, null).ratio).toBeNull();
  });

  it('reports a real zero as zero, not as missing', () => {
    // The chip renders this as "New" on a first turn and red 0% later; both need
    // a real 0 here, distinct from the null above.
    const reuse = selectCacheReuse(null, native({ inputTokens: 165_346, cacheReadTokens: 0, cacheCreationTokens: 0 }));
    expect(reuse.ratio).toBe(0);
  });

  it('clamps inconsistent provider counts instead of showing 340%', () => {
    const reuse = selectCacheReuse(null, native({ inputTokens: 100, cacheReadTokens: 340, cacheCreationTokens: 0 }));
    expect(reuse.ratio).toBe(1);
    expect(reuse.readTokens).toBe(340);   // raw numbers survive for the tooltip
  });

  it('does not divide by zero on an empty prompt', () => {
    expect(selectCacheReuse(null, native({ inputTokens: 0, cacheReadTokens: 0 })).ratio).toBeNull();
  });
});

// The chip's calm-first-turn rule (Destin, 2026-08-16): a fresh session has
// nothing to reuse, and rendering that as a red 0% reads as a failure the user
// caused. The SAME zero later does mean something broke, so it must stay loud.
describe('selectReuseDisplay — zero means different things at different times', () => {
  const zero = { readTokens: 0, promptTokens: 165_346, ratio: 0 };
  const high = { readTokens: 327_168, promptTokens: 331_432, ratio: 327_168 / 331_432 };

  it('shows "New" on the session\'s first turn instead of a red 0%', () => {
    expect(selectReuseDisplay(zero, 1)).toEqual({ kind: 'first-turn' });
    expect(selectReuseDisplay(zero, 0)).toEqual({ kind: 'first-turn' });
  });

  it('shows a real 0% once the session has history — the cache stopped working', () => {
    expect(selectReuseDisplay(zero, 2)).toEqual({ kind: 'percent', pct: 0 });
  });

  it('defaults to the calm reading when the turn count is not wired up', () => {
    expect(selectReuseDisplay(zero, undefined)).toEqual({ kind: 'first-turn' });
  });

  it('never says "New" when reuse actually happened', () => {
    // A first turn WITH tool calls reuses within itself, so "New" must not
    // swallow a genuine number just because the turn count is 1.
    expect(selectReuseDisplay(high, 1)).toEqual({ kind: 'percent', pct: 99 });
  });

  it('stays unknown when no cache data was reported at all', () => {
    const none = { readTokens: null, promptTokens: null, ratio: null };
    expect(selectReuseDisplay(none, 1)).toEqual({ kind: 'unknown' });
    expect(selectReuseDisplay(none, 2)).toEqual({ kind: 'unknown' });
  });
});
