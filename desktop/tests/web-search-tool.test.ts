import { describe, it, expect } from 'vitest';
import { WebSearchTool } from '../src/main/harness/tools/web-search';
import { SearchUnavailableError } from '../src/main/harness/search/search-service';

const ctxWith = (search: any) => ({ sessionId: 's', cwd: 'C:\\p', signal: new AbortController().signal, readRegistry: new Map(), todos: [] as any[], services: { search } });

describe('WebSearch tool', () => {
  it('formats results as a markdown list with the source', async () => {
    const r = await WebSearchTool.execute({ query: 'node lts' } as any, ctxWith({
      search: async () => ({ source: 'exa', results: [{ title: 'Node.js releases', url: 'https://nodejs.org/releases', snippet: 'LTS schedule' }] }),
    }) as any);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('Node.js releases');
    expect(r.text).toContain('https://nodejs.org/releases');
    expect(r.text).toContain('exa');
  });
  it('SearchUnavailable → honest error result (not a throw)', async () => {
    const r = await WebSearchTool.execute({ query: 'q' } as any, ctxWith({
      search: async () => { throw new SearchUnavailableError('Web search is unavailable right now. exa: limited. Tell the user: add a key.'); },
    }) as any);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('add a key');
  });
  it('missing service wiring → configuration error result', async () => {
    const bare = { sessionId: 's', cwd: 'C:\\p', signal: new AbortController().signal, readRegistry: new Map(), todos: [] as any[] };
    const r = await WebSearchTool.execute({ query: 'q' } as any, bare as any);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/configuration/i);
  });
  it('permissionSubject is the query', () => {
    expect(WebSearchTool.permissionSubject({ query: 'abc' } as any)).toBe('abc');
  });
});
