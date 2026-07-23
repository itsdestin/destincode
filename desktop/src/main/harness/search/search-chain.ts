// WebSearch backend chain — SHIPPED as data AND refreshed from a raw GitHub URL
// (the curated-models pattern, see src/main/models/curated-catalog.ts) so the
// chain is patchable without an app release. WHY: free search endpoints keep
// vanishing (Brave free tier dead Feb 2026, Bing dead Aug 2025 — see the
// youcoded-dev workspace doc docs/active/investigations/2026-07-15-web-search-backends.md).
import * as fs from 'fs';
import * as path from 'path';

export type SearchBackendId = 'exa' | 'ddg' | 'tavily';
export interface SearchChainEntry { backend: SearchBackendId; requiresKey: boolean }
const SEARCH_CHAIN_SCHEMA_VERSION = 1;
// Order rationale (plan decision 7): a user who added a Tavily key wants it
// used; keyless users skip it (requiresKey) and land on Exa keyless, then DDG.
export const SHIPPED_SEARCH_CHAIN: SearchChainEntry[] = [
  { backend: 'tavily', requiresKey: true },
  { backend: 'exa', requiresKey: false },
  { backend: 'ddg', requiresKey: false },
];

const REMOTE_URL = 'https://raw.githubusercontent.com/itsdestin/youcoded/master/search-chain.json';
const CACHE_FILE = 'search-chain-cache.json';
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

const VALID_BACKENDS: SearchBackendId[] = ['exa', 'ddg', 'tavily'];
function parseChain(payload: unknown): SearchChainEntry[] | null {
  const p = payload as { schemaVersion?: unknown; chain?: unknown };
  if (p?.schemaVersion !== SEARCH_CHAIN_SCHEMA_VERSION || !Array.isArray(p.chain)) return null;
  // Defensive parse: a malformed row is dropped, never guessed at.
  const rows = p.chain
    .filter((r: any) => r && VALID_BACKENDS.includes(r.backend))
    .map((r: any) => ({ backend: r.backend as SearchBackendId, requiresKey: r.requiresKey === true }));
  return rows.length > 0 ? rows : null;
}

// Reuse contract: construct ONE long-lived instance per process and share it.
// Unlike CuratedCatalog (hit once, on picker-open), get() is called on EVERY
// WebSearch, so a naive transplant would do a synchronous disk read per call
// and, on a stale/absent cache, an un-deduped network fetch of up to
// FETCH_TIMEOUT_MS. This class guards both against that hot-path footgun:
//   - an in-memory memo serves the resolved chain with ZERO I/O while fresh;
//   - an in-flight promise dedups concurrent resolves (thundering-herd guard).
// get() still may do disk I/O and — rarely, at most once per TTL — a network
// fetch up to FETCH_TIMEOUT_MS. It never throws on any path: memo → cache →
// remote → cache-fallback → shipped, in freshness order.
export class SearchChain {
  private cachePath: string;
  private memo: { chain: SearchChainEntry[]; fetchedAt: number } | null = null;
  private inflight: Promise<SearchChainEntry[]> | null = null;
  constructor(cacheDir: string, private fetchImpl: typeof fetch = fetch) {
    this.cachePath = path.join(cacheDir, CACHE_FILE);
  }

  private readCache(): { fetchedAt: number; chain: SearchChainEntry[] } | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      // Validate the STORED schemaVersion — pass the cache object straight to
      // parseChain rather than injecting the current version. Injecting would
      // make a future schema bump keep serving a stale v1 cache as if current.
      // (NOTE: curated-catalog.ts has this same latent gap — it injects
      // CURATED_SCHEMA_VERSION on read. Fixing it there is out of this task's
      // scope; recorded as a follow-up.)
      const chain = parseChain(parsed);
      if (typeof parsed.fetchedAt !== 'number' || !chain) return null;
      return { fetchedAt: parsed.fetchedAt, chain };
    } catch { return null; }
  }

  /** Never throws: memo → cache → remote → cache-fallback → shipped. */
  async get(): Promise<SearchChainEntry[]> {
    // In-memory memo: serve a fresh resolve with zero disk/network I/O.
    if (this.memo && Date.now() - this.memo.fetchedAt < TTL_MS) return this.memo.chain;
    // In-flight dedup: concurrent callers await the SAME resolve, not N races.
    if (this.inflight) return this.inflight;
    this.inflight = this.resolve().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async resolve(): Promise<SearchChainEntry[]> {
    const cached = this.readCache();
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
      this.memo = cached; // memoize the fresh cache hit
      return cached.chain;
    }
    try {
      const res = await this.fetchImpl(REMOTE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) {
        const chain = parseChain(await res.json());
        if (chain) {
          const fetchedAt = Date.now();
          try {
            fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
            fs.writeFileSync(this.cachePath, JSON.stringify({ schemaVersion: SEARCH_CHAIN_SCHEMA_VERSION, fetchedAt, chain }));
          } catch { /* cache write is best-effort */ }
          this.memo = { chain, fetchedAt }; // memoize the successful fetch
          return chain;
        }
      }
    } catch { /* offline / timeout — fall through */ }
    // The fallback is deliberately NOT memoized: we want the next call to retry
    // the remote rather than pinning shipped/stale for a full TTL.
    return cached?.chain ?? SHIPPED_SEARCH_CHAIN;
  }
}
