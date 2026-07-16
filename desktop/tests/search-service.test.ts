import { describe, it, expect } from 'vitest';
import { SearchService } from '../src/main/harness/search/search-service';
import { SearchBackendError, type SearchBackend } from '../src/main/harness/search/backends/types';

const R = [{ title: 'T', url: 'https://x.example', snippet: 's' }];
const chain = (entries: any[]) => ({ get: async () => entries });
const keys = (map: Record<string, string>) => ({ getKey: async (b: string) => map[b] ?? null });
const backend = (id: string, impl: SearchBackend['search']): SearchBackend => ({ id: id as any, search: impl });
const sig = () => new AbortController().signal;

describe('SearchService', () => {
  it('skips keyed entries without a key and uses the first success', async () => {
    const calls: string[] = [];
    const s = new SearchService(chain([
      { backend: 'tavily', requiresKey: true }, { backend: 'exa', requiresKey: false },
    ]) as any, keys({}) as any, {
      tavily: backend('tavily', async () => { calls.push('tavily'); return R; }),
      exa: backend('exa', async () => { calls.push('exa'); return R; }),
      ddg: backend('ddg', async () => { calls.push('ddg'); return R; }),
    });
    const out = await s.search('q', sig());
    expect(calls).toEqual(['exa']);
    expect(out.source).toBe('exa');
    expect(out.results).toEqual(R);
  });
  it('falls through on backend failure and reports the winning source', async () => {
    const s = new SearchService(chain([
      { backend: 'exa', requiresKey: false }, { backend: 'ddg', requiresKey: false },
    ]) as any, keys({}) as any, {
      exa: backend('exa', async () => { throw new SearchBackendError('per-IP limit reached'); }),
      ddg: backend('ddg', async () => R),
      tavily: backend('tavily', async () => R),
    });
    expect((await s.search('q', sig())).source).toBe('ddg');
  });
  it('exhaustion → SearchUnavailable with per-backend reasons AND the add-a-key hint', async () => {
    const s = new SearchService(chain([
      { backend: 'exa', requiresKey: false }, { backend: 'ddg', requiresKey: false },
    ]) as any, keys({}) as any, {
      exa: backend('exa', async () => { throw new SearchBackendError('per-IP limit reached'); }),
      ddg: backend('ddg', async () => { throw new SearchBackendError('DuckDuckGo is rate-limiting requests from this network right now.', true); }),
      tavily: backend('tavily', async () => R),
    });
    await expect(s.search('q', sig())).rejects.toThrow(/per-IP limit.*rate-limiting.*add.*key/is);
  });
  it('passes the stored key to keyed backends', async () => {
    let seenKey: string | null = 'unset' as any;
    const s = new SearchService(chain([{ backend: 'tavily', requiresKey: true }]) as any, keys({ tavily: 'tvly-9' }) as any, {
      tavily: backend('tavily', async (_q, o) => { seenKey = o.key; return R; }),
      exa: backend('exa', async () => R), ddg: backend('ddg', async () => R),
    });
    await s.search('q', sig());
    expect(seenKey).toBe('tvly-9');
  });
  it('a backend returning [] (no throw) is skipped and the chain continues to the next', async () => {
    const calls: string[] = [];
    const s = new SearchService(chain([
      { backend: 'exa', requiresKey: false }, { backend: 'ddg', requiresKey: false },
    ]) as any, keys({}) as any, {
      exa: backend('exa', async () => { calls.push('exa'); return []; }),
      ddg: backend('ddg', async () => { calls.push('ddg'); return R; }),
      tavily: backend('tavily', async () => R),
    });
    const out = await s.search('q', sig());
    expect(calls).toEqual(['exa', 'ddg']);
    expect(out.source).toBe('ddg');
  });
  it('ALL backends returning [] → SearchUnavailable (no silent empty)', async () => {
    const s = new SearchService(chain([
      { backend: 'exa', requiresKey: false }, { backend: 'ddg', requiresKey: false },
    ]) as any, keys({}) as any, {
      exa: backend('exa', async () => []),
      ddg: backend('ddg', async () => []),
      tavily: backend('tavily', async () => R),
    });
    await expect(s.search('q', sig())).rejects.toThrow(/unavailable/i);
  });
});
