import { describe, it, expect, afterEach } from 'vitest';
import { WebFetchTool, __setWebFetchTestHooks } from '../src/main/harness/tools/web-fetch';

const ctx = () => ({ sessionId: 's', cwd: 'C:\\proj', signal: new AbortController().signal, readRegistry: new Map(), todos: [] as any[] });
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

// Reset the injected hooks after every test so lookup/fetch state can't leak
// between cases (a stubbed fetch bleeding into the next test would be a silent lie).
afterEach(() => __setWebFetchTestHooks({}));

describe('WebFetch', () => {
  it('extracts an article to markdown', async () => {
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => html(
      '<html><head><title>Docs</title></head><body><nav>junk nav</nav><article><h1>API Guide</h1><p>' + 'Real content. '.repeat(40) + '</p></article></body></html>',
    ) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/docs', prompt: 'find the API guide' } as any, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('API Guide');
    expect(r.text).not.toContain('junk nav');       // Readability stripped chrome
    expect(r.text).toContain('find the API guide'); // prompt echoed as context header
  });
  it('passes plain text / json through', async () => {
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/api' } as any, ctx());
    expect(r.text).toContain('"ok":true');
  });
  it('refuses binaries honestly', async () => {
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200, headers: { 'content-type': 'application/pdf' } }) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/f.pdf' } as any, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/application\/pdf/);
  });
  it('surfaces HTTP errors with the status', async () => {
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => new Response('nope', { status: 404 }) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/missing' } as any, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toContain('404');
  });
  it('blocks private targets via the net-guard (integration)', async () => {
    __setWebFetchTestHooks({ lookup: async () => [{ address: '10.0.0.5', family: 4 }], fetchImpl: async () => html('x') });
    const r = await WebFetchTool.execute({ url: 'https://internal.corp/secrets' } as any, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/private|internal/i);
  });
  it('permissionSubject is the url', () => {
    expect(WebFetchTool.permissionSubject({ url: 'https://a.b/c' } as any)).toBe('https://a.b/c');
  });

  // --- extra edge tests (plan: "further edge tests you judge necessary") ---

  it('always emits the Source: line pointing at the final URL', async () => {
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => html(
      '<html><head><title>Docs</title></head><body><article><h1>API Guide</h1><p>' + 'Real content. '.repeat(40) + '</p></article></body></html>',
    ) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/docs' } as any, ctx());
    expect(r.text).toContain('Source: https://example.com/docs');
  });

  it('falls back to whole-body markdown when Readability finds no article', async () => {
    // A dashboard/index page with no readable article — Readability returns null,
    // and we must still return SOMETHING structured, never a silent empty result.
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => html(
      '<html><head><title>Dashboard</title></head><body><div><a href="/one">One</a><a href="/two">Two</a></div></body></html>',
    ) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/dash' } as any, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('One');
    expect(r.text).toContain('Two');
  });
});
