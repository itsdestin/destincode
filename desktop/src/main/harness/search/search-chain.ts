// WebSearch backend chain — SHIPPED as data AND refreshed from a raw GitHub URL
// (the curated-models pattern, see src/main/models/curated-catalog.ts) so the
// chain is patchable without an app release. WHY: free search endpoints keep
// vanishing (Brave free tier dead Feb 2026, Bing dead Aug 2025 — see the
// youcoded-dev workspace doc docs/active/investigations/2026-07-15-web-search-backends.md).
import * as fs from 'fs';
import * as path from 'path';

export type SearchBackendId = 'exa' | 'ddg' | 'tavily';
export interface SearchChainEntry { backend: SearchBackendId; requiresKey: boolean }
export const SEARCH_CHAIN_SCHEMA_VERSION = 1;
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

export class SearchChain {
  private cachePath: string;
  constructor(cacheDir: string, private fetchImpl: typeof fetch = fetch) {
    this.cachePath = path.join(cacheDir, CACHE_FILE);
  }

  private readCache(): { fetchedAt: number; chain: SearchChainEntry[] } | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      const chain = parseChain({ schemaVersion: SEARCH_CHAIN_SCHEMA_VERSION, chain: parsed.chain });
      if (typeof parsed.fetchedAt !== 'number' || !chain) return null;
      return { fetchedAt: parsed.fetchedAt, chain };
    } catch { return null; }
  }

  /** Never throws: remote → cache → shipped, in freshness order. */
  async get(): Promise<SearchChainEntry[]> {
    const cached = this.readCache();
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.chain;
    try {
      const res = await this.fetchImpl(REMOTE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) {
        const chain = parseChain(await res.json());
        if (chain) {
          try {
            fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
            fs.writeFileSync(this.cachePath, JSON.stringify({ fetchedAt: Date.now(), chain }));
          } catch { /* cache write is best-effort */ }
          return chain;
        }
      }
    } catch { /* offline / timeout — fall through */ }
    return cached?.chain ?? SHIPPED_SEARCH_CHAIN;
  }
}
