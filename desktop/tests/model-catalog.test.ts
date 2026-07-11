// ModelCatalog contract tests — fetch is injected, so these run with ZERO
// network. The upstream payload shapes here mirror the schema entries in
// docs/provider-dependencies.md (models.dev api.json + OpenRouter /models).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { ModelCatalog } from '../src/main/providers/model-catalog';

const OPENROUTER_PAYLOAD = { data: [
  { id: 'meta-llama/llama-3-8b', name: 'Llama 3 8B', context_length: 8192, pricing: { prompt: '0.00000005', completion: '0.0000001' } },
] };
// models.dev api.json: { [providerKey]: { models: { [modelKey]: {...} } } } —
// exact schema recorded in provider-dependencies.md; parse defensively.
const MODELSDEV_PAYLOAD = { anthropic: { models: {
  'claude-sonnet-5': { name: 'Claude Sonnet 5', limit: { context: 200000 }, tool_call: true, reasoning: true,
    cost: { input: 3, output: 15 } },
} } };

describe('ModelCatalog', () => {
  let dir: string; let fetchMock: any; let cat: ModelCatalog;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-catalog-'));
    fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.includes('openrouter') ? OPENROUTER_PAYLOAD : MODELSDEV_PAYLOAD,
    }));
    cat = new ModelCatalog(dir, fetchMock);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('merges OpenRouter + models.dev into CatalogModel rows scoped to enabled providers', async () => {
    const models = await cat.get([
      { id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true },
      { id: 'anth1', type: 'anthropic', label: 'Anthropic', enabled: true, builtIn: false, hasKey: true, ready: true },
    ] as any);
    const or = models.find((m) => m.providerId === 'openrouter');
    expect(or).toMatchObject({ id: 'meta-llama/llama-3-8b', contextLength: 8192 });
    const an = models.find((m) => m.providerId === 'anth1');
    expect(an).toMatchObject({ id: 'claude-sonnet-5', contextLength: 200000, supportsTools: true });
  });

  it('disabled providers contribute no models', async () => {
    const models = await cat.get([
      { id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: false, builtIn: true, hasKey: true, ready: false },
    ] as any);
    expect(models).toHaveLength(0);
  });

  it('serves from disk cache within TTL (single fetch pair across two calls)', async () => {
    const providers = [{ id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true }] as any;
    await cat.get(providers);
    const callsAfterFirst = fetchMock.mock.calls.length;
    await cat.get(providers);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // cache hit — no new fetches
  });

  it('a failed fetch falls back to stale cache instead of throwing', async () => {
    const providers = [{ id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true }] as any;
    await cat.get(providers);                    // primes cache
    (cat as any).ttlMs = -1;                     // force expiry
    fetchMock.mockRejectedValue(new Error('offline'));
    const models = await cat.get(providers);
    expect(models.length).toBeGreaterThan(0);    // stale data served
  });

  it('no cache + failed fetch yields an empty catalog, never a throw', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const models = await cat.get([{ id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true }] as any);
    expect(models).toEqual([]);
  });

  it('contextLengthFor answers from the merged catalog', async () => {
    const providers = [{ id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true }] as any;
    await cat.get(providers);
    expect(await cat.contextLengthFor({ providerId: 'openrouter', modelId: 'meta-llama/llama-3-8b' }, providers)).toBe(8192);
    expect(await cat.contextLengthFor({ providerId: 'openrouter', modelId: 'unknown' }, providers)).toBeNull();
  });

  it('malformed upstream rows are skipped, not crashed on', async () => {
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => url.includes('openrouter')
        ? { data: [{ id: 'good-model', name: 'Good' }, { name: 'no id — skip me' }, null, 'garbage'] }
        : { weird: 'shape' },
    }));
    const models = await cat.get([{ id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: true, builtIn: true, hasKey: true, ready: true }] as any);
    expect(models.map((m) => m.id)).toEqual(['good-model']);
  });
});
