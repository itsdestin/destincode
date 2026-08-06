import { describe, it, expect, afterEach, vi } from 'vitest';
import { Readability } from '@mozilla/readability';
import { WebFetchTool, __setWebFetchTestHooks } from '../src/main/harness/tools/web-fetch';

const ctx = () => ({ sessionId: 's', cwd: 'C:\\proj', signal: new AbortController().signal, readRegistry: new Map(), todos: [] as any[] });
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

// Shared stub-and-execute helper (task 11 brief: reuse the existing test-hooks
// pattern under one name instead of repeating the two-line stub at every call site).
const fetchWith = async (body: string, url = 'https://example.com/deep') => {
  __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => html(body) });
  return WebFetchTool.execute({ url } as any, ctx());
};

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

  // --- DoS complexity-guard tests (CRITICAL: main-thread freeze) ---

  it('degrades hostile DOM depth to plain text WITHOUT reaching Readability', async () => {
    // 5000-deep nesting would take TENS of seconds in Readability's ~quadratic
    // parse and freeze the whole app. The O(n) pre-check must reject it BEFORE
    // Readability runs (the guard fires long before parse), so this test also
    // returns fast.
    // UPDATED (task 11, 2026-08-06): the guard's outcome changed from a hard
    // refusal to a degraded success — tag-stripping is O(n) and safe, so a
    // rejected page can still return honest content instead of nothing. The
    // Readability spy is what still proves the DoS guard itself is intact.
    const parseSpy = vi.spyOn(Readability.prototype, 'parse');
    const deep = '<html><body>' + '<div>'.repeat(5000) + 'x' + '</div>'.repeat(5000) + '</body></html>';
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => html(deep) });
    const t0 = Date.now();
    const r = await WebFetchTool.execute({ url: 'https://example.com/deep' } as any, ctx());
    const elapsed = Date.now() - t0;
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/too large or deeply nested/);
    expect(r.text).toContain('simplified extraction');
    expect(parseSpy).not.toHaveBeenCalled();
    // If Readability had run, this would be many seconds; the guard keeps it tiny.
    expect(elapsed).toBeLessThan(1000);
    parseSpy.mockRestore();
  });

  it('degrades a high tag count (huge table / anchor list) WITHOUT reaching Readability', async () => {
    // ~40k tags — far past MAX_TAGS. Cost here is breadth, not depth.
    // UPDATED (task 11, 2026-08-06): see note above — refusal became a degraded
    // success; the Readability spy proves the guard still stopped the parse.
    const parseSpy = vi.spyOn(Readability.prototype, 'parse');
    const wide = '<html><body><table>' + '<tr><td>x</td></tr>'.repeat(20000) + '</table></body></html>';
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => html(wide) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/wide' } as any, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/too large or deeply nested/);
    expect(r.text).toContain('simplified extraction');
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it('lets a normal article through the guard (depth/tags well under caps)', async () => {
    // Realistic article with moderate nesting and tag count — must NOT be rejected.
    const article = '<html><head><title>Docs</title></head><body><header><nav>'
      + '<a href="#">home</a>'.repeat(10) + '</nav></header><main><article><h1>API Guide</h1>'
      + '<section><p>Real content that is long enough to be extractable. </p></section>'.repeat(30)
      + '</article></main></body></html>';
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => html(article) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/docs' } as any, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('API Guide');
  });

  it('returns a clean isError (never an uncaught throw) on malformed HTML', async () => {
    // The reviewer saw `new Readability(document)` throw on some malformed input.
    // defineTool's try/catch must convert any such throw into an isError result,
    // not let it escape as an uncaught exception. Passes the depth/tag guard first.
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => html('<html><body><p>< < </ ></</body') });
    const r = await WebFetchTool.execute({ url: 'https://example.com/malformed' } as any, ctx());
    // Either it extracts something OR it errors cleanly — the ONLY failure mode we
    // forbid is a rejected promise / uncaught throw, and awaiting proves neither.
    expect(typeof r.text).toBe('string');
  });

  it('sniffs a no-content-type response and extracts it as HTML', async () => {
    // A bare/misconfigured server omits content-type. If the body is clearly HTML,
    // read it instead of refusing it as an "unknown binary type".
    // NOTE: a STRING body makes Response auto-add `content-type: text/plain`, which
    // would defeat the no-content-type path — encode to bytes so the header stays
    // genuinely absent (mirrors the real bare-server case).
    const bareBody = new TextEncoder().encode(
      '<!doctype html><html><head><title>Bare</title></head><body><article><h1>Bare Server</h1><p>'
        + 'Real content. '.repeat(40) + '</p></article></body></html>',
    );
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => new Response(bareBody, { status: 200 }) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/bare' } as any, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('Bare Server');
  });

  it('falls back to plain text instead of refusing when the page is too complex', async () => {
    // 200 nested divs — past MAX_DEPTH 150, so Readability must not run. The old
    // code hard-failed here, leaving the model with nothing (Kimi K3 finding #1).
    const deep = '<div>'.repeat(200) + 'THE CONTENT' + '</div>'.repeat(200);
    const r = await fetchWith(`<html><body>${deep}</body></html>`);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('THE CONTENT');
    expect(r.text).toContain('simplified extraction');
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
