import { describe, it, expect, beforeEach } from 'vitest';
import { ThemePRLookup } from '../src/main/theme-pr-lookup';

// Phase 3 (2026-07-22): ThemePRLookup runs on the GitHub SEARCH API (was a
// `gh pr list` wrapper). Fakes inject fetch + token source — no gh, no network.

describe('ThemePRLookup', () => {
  let calls: string[];
  let stubItems: Record<string, any[]>; // url-substring → search items
  let lookup: ThemePRLookup;
  let token: string | null;

  beforeEach(() => {
    calls = [];
    stubItems = {};
    token = 'gho_token';
    const fakeFetch = async (url: string, _init?: any) => {
      calls.push(url);
      const hit = Object.entries(stubItems).find(([part]) => url.includes(part));
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: hit ? hit[1] : [] }),
      };
    };
    lookup = new ThemePRLookup({
      fetchFn: fakeFetch as any,
      getToken: async () => token,
      ttlMs: 60_000,
      now: () => 1_000,
    });
  });

  it('returns null when the search returns no items', async () => {
    const result = await lookup.findOpenPR('sunset', 'alice');
    expect(result).toBeNull();
  });

  it('returns the first matching PR and scopes the query to repo/author/state', async () => {
    stubItems['state%3Aopen'] = [{ number: 42, html_url: 'https://x/pull/42' }];
    const result = await lookup.findOpenPR('sunset', 'alice');
    expect(result).toEqual({ number: 42, url: 'https://x/pull/42' });
    const q = decodeURIComponent(calls[0]);
    expect(q).toContain('repo:itsdestin/wecoded-themes');
    expect(q).toContain('author:alice');
    expect(q).toContain('state:open');
    expect(q).toContain('sunset');
  });

  it('caches results within the TTL window', async () => {
    await lookup.findOpenPR('sunset', 'alice');
    await lookup.findOpenPR('sunset', 'alice');
    expect(calls.length).toBe(1);
  });

  it('refetches after invalidation', async () => {
    await lookup.findOpenPR('sunset', 'alice');
    lookup.invalidate('sunset', 'alice');
    await lookup.findOpenPR('sunset', 'alice');
    expect(calls.length).toBe(2);
  });

  it('searches recently merged PRs with the 5-minute merged:>= window', async () => {
    await lookup.findRecentlyMergedPR('sunset', 'alice');
    const q = decodeURIComponent(calls[0]);
    expect(q).toContain('is:merged');
    expect(q).toContain('sunset');
    expect(q).toMatch(/merged:>=/);
  });

  it('works ANONYMOUSLY when no token exists (the old gh path just failed here)', async () => {
    token = null;
    stubItems['state%3Aopen'] = [{ number: 7, html_url: 'https://x/pull/7' }];
    const result = await lookup.findOpenPR('sunset', 'alice');
    expect(result).toEqual({ number: 7, url: 'https://x/pull/7' });
  });

  it('falls back to null on fetch failure', async () => {
    const failing = new ThemePRLookup({
      fetchFn: (async () => { throw new Error('network down'); }) as any,
      getToken: async () => null,
      ttlMs: 60_000, now: () => 1_000,
    });
    const result = await failing.findOpenPR('sunset', 'alice');
    expect(result).toBeNull();
  });
});
