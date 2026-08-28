// desktop/tests/model-catalog-pricing.test.ts
//
// The app's copy of the price list used to drop the cache rates, which forced
// the session-cost chip to over-report and apologise for it in a tooltip. The
// rates are in the payload; carry them (spec §5).
import { describe, it, expect } from 'vitest';
import { ModelCatalog } from '../src/main/providers/model-catalog';

describe('catalog pricing', () => {
  it('maps OpenRouter per-token strings to per-1M, cache rates included', () => {
    const rows = (ModelCatalog as any).prototype.openrouterModels.call({}, {
      data: [{
        id: 'vendor/model',
        pricing: {
          prompt: '0.000003', completion: '0.000015',
          input_cache_read: '0.0000003', input_cache_write: '0.00000375',
        },
      }],
    }, 'openrouter');
    expect(rows[0].pricing).toEqual({ in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  });

  it('omits cache rates that are absent or malformed rather than guessing zero', () => {
    const rows = (ModelCatalog as any).prototype.openrouterModels.call({}, {
      data: [{ id: 'vendor/model', pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '' } }],
    }, 'openrouter');
    expect(rows[0].pricing).toEqual({ in: 3, out: 15 });
  });

  it('maps models.dev cost fields, which are already per-1M', () => {
    const rows = (ModelCatalog as any).prototype.modelsdevModels.call({}, {
      anthropic: { models: { 'x': { id: 'x', cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } } },
    }, 'anthropic', 'anthropic');
    expect(rows[0].pricing).toEqual({ in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  });

  // A field of pure whitespace ('  ', '\t') is a published-nothing, same as ''.
  // Number('  ') is 0 and '  ' !== '', so a bare non-empty-string gate turns a
  // padded field into a REAL rate of zero — cached reads billed at $0, or the
  // whole model priced free. These pin the trim.
  it('treats a whitespace-only cache rate as "not published", never as free', () => {
    const rows = (ModelCatalog as any).prototype.openrouterModels.call({}, {
      data: [{
        id: 'vendor/model',
        pricing: {
          prompt: '0.000003', completion: '0.000015',
          input_cache_read: '  ', input_cache_write: '\t',
        },
      }],
    }, 'openrouter');
    expect(rows[0].pricing).toEqual({ in: 3, out: 15 });
  });

  it('treats a whitespace-only base rate as "not published", never as free', () => {
    const rows = (ModelCatalog as any).prototype.openrouterModels.call({}, {
      data: [{ id: 'vendor/model', pricing: { prompt: '  ', completion: '  ' } }],
    }, 'openrouter');
    expect(rows[0].pricing).toBeUndefined();
  });

  // models.dev half of the never-guess rule (the OpenRouter half is pinned
  // above). cost.cache_read/cache_write must be NUMBERS to be carried; absent,
  // null, or string-shaped means the source published no cache rate, and the
  // cost chip must fall back to the full input rate rather than bill $0.
  it('omits models.dev cache rates that are absent, null, or non-numeric', () => {
    const call = (models: any) => (ModelCatalog as any).prototype.modelsdevModels.call(
      {}, { anthropic: { models } }, 'anthropic', 'anthropic');

    expect(call({ absent: { cost: { input: 3, output: 15 } } })[0].pricing)
      .toEqual({ in: 3, out: 15 });
    expect(call({ nulled: { cost: { input: 3, output: 15, cache_read: null, cache_write: null } } })[0].pricing)
      .toEqual({ in: 3, out: 15 });
    expect(call({ stringy: { cost: { input: 3, output: 15, cache_read: '0.3', cache_write: '3.75' } } })[0].pricing)
      .toEqual({ in: 3, out: 15 });
  });
});
