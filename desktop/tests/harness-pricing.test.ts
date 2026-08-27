// Tokens → dollars, in the one place that does it (spec §5).
//
// The zero-rate case is the reason this file also reaches into ModelCatalog:
// OpenRouter publishes its `:free` models with a price of the STRING "0",
// which the catalog mapper faithfully turns into a real rate of 0. Left
// alone, that would make a free model report a priced session cost of exactly
// $0.00 — the false zero docs/error-message-standards.md forbids. The
// end-to-end test below pins the decision made here: an all-zero rate card is
// FREE, not priced.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { costForUsage, isFreePricing } from '../src/main/harness/pricing';
import { ModelCatalog } from '../src/main/providers/model-catalog';

const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheCreationTokens: 0 };

describe('costForUsage', () => {
  it('prices plain input and output per 1M tokens', () => {
    expect(costForUsage(usage, { in: 3, out: 15 })).toBeCloseTo(3 + 1.5, 10);
  });

  it('charges cached reads at the cache rate, not the full input rate', () => {
    const u = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 900_000, cacheCreationTokens: 0 };
    // 100k uncached at $3/M + 900k cached at $0.30/M
    expect(costForUsage(u, { in: 3, out: 15, cacheRead: 0.3 })).toBeCloseTo(0.3 + 0.27, 10);
  });

  it('charges cache writes at the write rate on top of the prompt', () => {
    const u = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 500_000 };
    expect(costForUsage(u, { in: 3, out: 15, cacheWrite: 3.75 })).toBeCloseTo(3 + 1.875, 10);
  });

  it('falls back to the full input rate when no cache rate is published', () => {
    const u = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 900_000, cacheCreationTokens: 0 };
    expect(costForUsage(u, { in: 3, out: 15 })).toBeCloseTo(3, 10);
  });

  it('returns null — never 0 — when there is no price at all', () => {
    expect(costForUsage(usage, null)).toBeNull();
    expect(costForUsage(usage, undefined)).toBeNull();
  });

  it('never returns a negative number if a provider reports more cached than prompt tokens', () => {
    const u = { inputTokens: 100, outputTokens: 0, cacheReadTokens: 5_000, cacheCreationTokens: 0 };
    expect(costForUsage(u, { in: 3, out: 15, cacheRead: 0.3 })).toBeGreaterThanOrEqual(0);
  });

  // The clamp itself, not just its sign. The test above is satisfied by the
  // trailing Math.max(0, ...) alone, so the clamp could be deleted and stay
  // green — this pins the FIGURE. A provider can only have served from cache
  // what it was actually sent: 100 prompt tokens means at most 100 cached
  // reads, whatever the 5,000 it reported. Billing the raw number here is
  // $0.0015 instead of $0.00003 — 50x the real cost, and still positive.
  it('bills at most the prompt size when a provider reports more cached reads than prompt tokens', () => {
    const u = { inputTokens: 100, outputTokens: 0, cacheReadTokens: 5_000, cacheCreationTokens: 0 };
    expect(costForUsage(u, { in: 3, out: 15, cacheRead: 0.3 })).toBeCloseTo(100 / 1e6 * 0.3, 10);
  });
});

describe('a rate card of all zeroes means FREE, not priced-at-zero', () => {
  it('costForUsage returns null for an all-zero rate card', () => {
    expect(costForUsage(usage, { in: 0, out: 0 })).toBeNull();
    expect(costForUsage(usage, { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });

  it('isFreePricing checks all four rates, not just in and out', () => {
    expect(isFreePricing({ in: 0, out: 0 })).toBe(true);
    expect(isFreePricing({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 })).toBe(true);
    // A card that charges for cache reads is NOT free, even at in/out of zero —
    // a real cached session would cost real money.
    expect(isFreePricing({ in: 0, out: 0, cacheRead: 0.3 })).toBe(false);
    expect(isFreePricing({ in: 0, out: 0, cacheWrite: 3.75 })).toBe(false);
    expect(isFreePricing({ in: 3, out: 15 })).toBe(false);
  });

  it('a card that charges only for cache reads still prices those reads', () => {
    const u = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 0 };
    expect(costForUsage(u, { in: 0, out: 0, cacheRead: 0.3 })).toBeCloseTo(0.3, 10);
  });

  it('"no price published" is NOT free — the two states must not collapse', () => {
    expect(isFreePricing(null)).toBe(false);
    expect(isFreePricing(undefined)).toBe(false);
  });
});

describe("an OpenRouter ':free' model, end to end through the catalog", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-pricing-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('maps to a zero rate card, which costForUsage refuses to price', async () => {
    // The exact upstream shape: OpenRouter publishes `:free` variants with
    // price STRINGS of "0", which pass the mapper's non-empty-string guard.
    const payload = { data: [
      { id: 'meta-llama/llama-3-8b:free', name: 'Llama 3 8B (free)', context_length: 8192,
        pricing: { prompt: '0', completion: '0', input_cache_read: '0', input_cache_write: '0' } },
    ] };
    const cat = new ModelCatalog(dir, vi.fn(async () => ({ ok: true, json: async () => payload })) as any);
    const models = await cat.get([
      { id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true },
    ] as any);
    const free = models.find((m) => m.id === 'meta-llama/llama-3-8b:free');
    // The catalog still reports the published rate faithfully — zero IS what
    // upstream said. Deciding what a zero MEANS is this module's job.
    expect(free!.pricing).toEqual({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
    expect(isFreePricing(free!.pricing)).toBe(true);
    expect(costForUsage(usage, free!.pricing)).toBeNull();
  });
});
