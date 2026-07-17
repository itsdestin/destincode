import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SearchChain, SHIPPED_SEARCH_CHAIN } from '../src/main/harness/search/search-chain';

// Track every temp dir we create so afterEach can remove it (mirrors the
// rmSync cleanup in tests/curated-catalog.test.ts — dropped in the transplant).
const dirs: string[] = [];
const cacheDir = () => { const d = mkdtempSync(join(tmpdir(), 'yc-chain-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const CACHE_FILE = 'search-chain-cache.json';
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
    // Seed the cache with one instance.
    await new SearchChain(dir, okFetch(remote)).get();
    // A fresh instance whose fetch would throw proves the disk cache short-circuits it.
    let fetched = false;
    const throwIfFetched = (async () => { fetched = true; throw new Error('should not fetch'); }) as typeof fetch;
    const c = new SearchChain(dir, throwIfFetched);
    expect((await c.get()).map((e) => e.backend)).toEqual(['ddg']);
    expect(fetched).toBe(false);
  });

  // Hot-path reuse guards (memo + in-flight dedup).
  it('dedups concurrent get() into a single fetch (thundering-herd guard)', async () => {
    let calls = 0;
    const countingFetch = (async () => {
      calls++;
      // Delay so all concurrent get() calls arrive before this resolve completes.
      await new Promise((r) => setTimeout(r, 10));
      return new Response(JSON.stringify({ schemaVersion: 1, chain: [{ backend: 'exa', requiresKey: false }] }), { status: 200 });
    }) as typeof fetch;
    const c = new SearchChain(cacheDir(), countingFetch);
    const [a, b, d] = await Promise.all([c.get(), c.get(), c.get()]);
    expect(calls).toBe(1);
    expect(a.map((e) => e.backend)).toEqual(['exa']);
    expect(b).toEqual(a);
    expect(d).toEqual(a);
  });
  it('serves the in-memory memo within TTL — no disk read, no refetch', async () => {
    const dir = cacheDir();
    let calls = 0;
    const remote = { schemaVersion: 1, chain: [{ backend: 'ddg', requiresKey: false }] };
    const countingFetch = (async () => { calls++; return new Response(JSON.stringify(remote), { status: 200 }); }) as typeof fetch;
    const c = new SearchChain(dir, countingFetch);
    expect((await c.get()).map((e) => e.backend)).toEqual(['ddg']);
    expect(calls).toBe(1);
    // Delete the cache file: a memo hit must not touch disk (else readCache
    // fails → refetch → calls becomes 2).
    unlinkSync(join(dir, CACHE_FILE));
    expect((await c.get()).map((e) => e.backend)).toEqual(['ddg']);
    expect(calls).toBe(1); // no disk read AND no refetch
  });

  // Cache schema-version gate: a stored version that isn't current is a miss.
  it('ignores a cache file with a stale schemaVersion → shipped', async () => {
    const dir = cacheDir();
    // Hand-write a cache pinned to an obsolete schema version.
    writeFileSync(join(dir, CACHE_FILE), JSON.stringify({ schemaVersion: 0, fetchedAt: Date.now(), chain: [{ backend: 'exa', requiresKey: false }] }));
    const c = new SearchChain(dir, failFetch);
    expect(await c.get()).toEqual(SHIPPED_SEARCH_CHAIN);
  });
});
