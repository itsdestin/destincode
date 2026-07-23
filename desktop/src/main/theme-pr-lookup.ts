// theme-pr-lookup.ts
// Checks whether a theme submission has an open or recently-merged PR in the
// wecoded-themes repo, via the GitHub search API (Phase 3, 2026-07-22 — was a
// `gh pr list` wrapper; REST removes the gh dependency and, when a token is
// available through the github-client, lifts the rate limit from 60/hr
// anonymous to 5,000/hr authed. Anonymous still WORKS — a machine with no
// GitHub credential merely degrades on rate limits, where the old gh path
// returned null unconditionally).
//
// Used by publish-state-resolver to bridge the post-merge / pre-registry-CI
// window: after a PR merges, the registry hasn't rebuilt yet, so the theme
// would otherwise flash back to "draft" for ~1 minute. findRecentlyMergedPR
// covers that gap.
//
// Both methods cache per (slug, author) pair for ttlMs (default 60s) so rapid
// navigation between theme details doesn't thrash the API. On any failure
// (network down, rate-limited, expired token) they return null — callers
// treat that as "no PR found" and decide separately whether to surface a
// degraded-mode warning.

import { getGithubClient } from './github-client';
import type { FetchLike } from './github-auth';

const REPO = 'itsdestin/wecoded-themes';
const DEFAULT_TTL_MS = 60_000;
// How far back to look when searching for recently-merged PRs.
const MERGED_WINDOW_MIN = 5;
// Per-call timeout. If the API hangs (dead network, DNS stall) we'd otherwise
// freeze the publish-state resolver — the renderer UI would sit on "Checking
// publish status…" forever.
const LOOKUP_TIMEOUT_MS = 5000;

export interface PRRef {
  number: number;
  url: string;
}

interface CacheEntry {
  value: PRRef | null;
  expires: number;
}

export interface ThemePRLookupOpts {
  /** Injectable fetch for testing — defaults to global fetch with a timeout. */
  fetchFn?: FetchLike;
  /** Injectable token source — defaults to the github-client singleton
   *  (null = anonymous search, which still works at 60 req/hr). */
  getToken?: () => Promise<string | null>;
  /** Cache TTL in milliseconds — defaults to 60 000 */
  ttlMs?: number;
  /** Monotonic clock injectable for tests — defaults to Date.now */
  now?: () => number;
}

const defaultFetch: FetchLike = (url, init) =>
  fetch(url, { ...(init as RequestInit), signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });

const defaultGetToken = async (): Promise<string | null> => {
  try { return (await getGithubClient()?.getToken())?.token ?? null; }
  catch { return null; }
};

export class ThemePRLookup {
  private openCache = new Map<string, CacheEntry>();
  private mergedCache = new Map<string, CacheEntry>();
  private fetchFn: FetchLike;
  private getToken: () => Promise<string | null>;
  private ttlMs: number;
  private now: () => number;

  constructor(opts: ThemePRLookupOpts = {}) {
    this.fetchFn = opts.fetchFn ?? defaultFetch;
    this.getToken = opts.getToken ?? defaultGetToken;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Bust the cache for a specific (slug, author) pair — call after submitting or merging. */
  invalidate(slug: string, author: string): void {
    const key = `${author}/${slug}`;
    this.openCache.delete(key);
    this.mergedCache.delete(key);
  }

  /** Returns the first open PR matching (slug, author), or null if none / on error. */
  async findOpenPR(slug: string, author: string): Promise<PRRef | null> {
    return this.cached(this.openCache, `${author}/${slug}`, async () =>
      this.searchFirst(`repo:${REPO} is:pr state:open author:${author} ${slug}`));
  }

  /**
   * Returns the first PR merged within the last MERGED_WINDOW_MIN minutes that
   * matches (slug, author), or null if none / on error.
   *
   * This bridges the post-merge / pre-registry-CI window so the UI doesn't
   * briefly revert to "draft" state while the registry rebuild is in flight.
   */
  async findRecentlyMergedPR(slug: string, author: string): Promise<PRRef | null> {
    return this.cached(this.mergedCache, `${author}/${slug}`, async () => {
      // ISO timestamp for "5 minutes ago" — the search API supports the same
      // merged:>=<ISO8601> qualifier gh's --search forwarded to it.
      const cutoff = new Date(this.now() - MERGED_WINDOW_MIN * 60_000).toISOString();
      return this.searchFirst(`repo:${REPO} is:pr is:merged author:${author} merged:>=${cutoff} ${slug}`);
    });
  }

  // --- private helpers ---

  private async cached(
    cache: Map<string, CacheEntry>,
    key: string,
    fetcher: () => Promise<PRRef | null>,
  ): Promise<PRRef | null> {
    const hit = cache.get(key);
    if (hit && hit.expires > this.now()) return hit.value;
    const value = await fetcher();
    cache.set(key, { value, expires: this.now() + this.ttlMs });
    return value;
  }

  /** GET /search/issues for the query; first hit as a PRRef, null on anything else. */
  private async searchFirst(query: string): Promise<PRRef | null> {
    try {
      const token = await this.getToken();
      const res = await this.fetchFn(
        `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=1`,
        {
          method: 'GET',
          headers: {
            // Anonymous when no token — search allows it (rate-limited).
            ...(token ? { Authorization: `token ${token}` } : {}),
            Accept: 'application/vnd.github+json',
            'User-Agent': 'YouCoded',
          },
        },
      );
      const json: any = await res.json().catch(() => null);
      const first = Array.isArray(json?.items) ? json.items[0] : null;
      if (first && typeof first.number === 'number') {
        return { number: first.number, url: String(first.html_url ?? '') };
      }
      return null;
    } catch {
      // Network error, rate-limited, timeout — degrade gracefully.
      return null;
    }
  }
}
