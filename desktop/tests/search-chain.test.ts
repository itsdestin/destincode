import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SearchChain, SHIPPED_SEARCH_CHAIN } from '../src/main/harness/search/search-chain';

const cacheDir = () => mkdtempSync(join(tmpdir(), 'yc-chain-'));
const okFetch = (payload: unknown) => (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
const failFetch = (async () => { throw new Error('offline'); }) as typeof fetch;

describe('SearchChain', () => {
  it('ships tavily(keyed) → exa → ddg', () => {
    expect(SHIPPED_SEARCH_CHAIN.map((e) => e.backend)).toEqual(['tavily', 'exa', 'ddg']);
    expect(SHIPPED_SEARCH_CHAIN[0].requiresKey).toBe(true);
  });
  it('returns the remote chain when valid and caches it', async () => {
    const remote = { schemaVersion: 1, chain: [{ backend: 'exa', requiresKey: false }] };
    const c = new SearchChain(cacheDir(), okFetch(remote));
    expect((await c.get()).map((e) => e.backend)).toEqual(['exa']);
  });
  it('falls back to shipped on offline', async () => {
    const c = new SearchChain(cacheDir(), failFetch);
    expect(await c.get()).toEqual(SHIPPED_SEARCH_CHAIN);
  });
  it('falls back on schemaVersion mismatch', async () => {
    const c = new SearchChain(cacheDir(), okFetch({ schemaVersion: 99, chain: [] }));
    expect(await c.get()).toEqual(SHIPPED_SEARCH_CHAIN);
  });
  it('drops malformed rows instead of failing the whole chain', async () => {
    const remote = { schemaVersion: 1, chain: [{ backend: 'ddg', requiresKey: false }, { backend: 'not-a-backend' }, { nonsense: true }] };
    const c = new SearchChain(cacheDir(), okFetch(remote));
    expect((await c.get()).map((e) => e.backend)).toEqual(['ddg']);
  });

  // Cache-behavior coverage mirroring tests/curated-catalog.test.ts.
  it('serves the disk cache to a later offline instance', async () => {
    const dir = cacheDir();
    const remote = { schemaVersion: 1, chain: [{ backend: 'exa', requiresKey: false }, { backend: 'ddg', requiresKey: false }] };
    // First instance fetches + caches.
    const online = new SearchChain(dir, okFetch(remote));
    expect((await online.get()).map((e) => e.backend)).toEqual(['exa', 'ddg']);
    // Second instance with a dead network serves the disk cache, not shipped.
    const offline = new SearchChain(dir, failFetch);
    expect((await offline.get()).map((e) => e.backend)).toEqual(['exa', 'ddg']);
  });
  it('serves the fresh disk cache without fetching', async () => {
    const dir = cacheDir();
    const remote = { schemaVersion: 1, chain: [{ backend: 'ddg', requiresKey: false }] };
    // Seed the cache.
    await new SearchChain(dir, okFetch(remote)).get();
    // A fetch that would throw if called proves the fresh cache short-circuits it.
    let fetched = false;
    const throwIfFetched = (async () => { fetched = true; throw new Error('should not fetch'); }) as typeof fetch;
    const c = new SearchChain(dir, throwIfFetched);
    expect((await c.get()).map((e) => e.backend)).toEqual(['ddg']);
    expect(fetched).toBe(false);
  });
});
