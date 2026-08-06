import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { WebFetchTool, __setWebFetchTestHooks, looksJsRendered, resolveFragment } from '../src/main/harness/tools/web-fetch';

const ctx = () => ({ sessionId: 's', cwd: 'C:\\proj', signal: new AbortController().signal, readRegistry: new Map(), todos: [] as any[] });
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

// Real-page fixtures (task 12): vitest-config.html is the false-negative page —
// its documented content arrives via client-side JS, so a reviewing model asking
// about `include` gets a confident-but-wrong "not documented" answer. asyncio.html
// is a server-rendered page of near-identical extraction ratio, pinned so a
// threshold tweak that "fixes" one can't silently break the other.
const fixture = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'web', n), 'utf8');

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

  it('DOES call Readability.parse on a normal page that clears the guard (positive control)', async () => {
    // MINOR finding (2026-08-06 re-review): every other test in this describe
    // block that spies on Readability.prototype.parse asserts it was NOT
    // called (guard-path tests above). Nothing previously asserted it IS
    // called on the normal path — a change that stopped invoking Readability
    // entirely (e.g. always falling through to the plain-text path) would
    // have left all three of those tests green. This is that missing control.
    const parseSpy = vi.spyOn(Readability.prototype, 'parse');
    const article = '<html><head><title>Docs</title></head><body><article><h1>API Guide</h1><p>'
      + 'Real content that is long enough to be extractable. '.repeat(30) + '</p></article></body></html>';
    __setWebFetchTestHooks({ lookup: publicLookup, fetchImpl: async () => html(article) });
    const r = await WebFetchTool.execute({ url: 'https://example.com/normal' } as any, ctx());
    expect(r.isError).toBeUndefined();
    expect(parseSpy).toHaveBeenCalled();
    parseSpy.mockRestore();
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

  it('does not freeze on 200,000 unterminated "<" characters (CRITICAL DoS regression)', async () => {
    // WHY this exact shape (2026-08-06 review): tooComplexToExtract() counts
    // every '<' regardless of whether it is ever closed by a '>', so this
    // 200,012-byte body (far under the 5MB cap) trips the tag-count guard and
    // is handed to the plain-text fallback. The OLD fallback used
    // /<[^>]*>/g, which — because none of these 200,000 '<' are ever followed
    // by a '>' — retries its match at every subsequent character, each retry
    // re-scanning to the end of the string. Measured directly against that
    // regex on this exact input: 12,194ms. The fix (a hand-written, strictly
    // forward-moving scan — see stripToText's WHY comment) must complete in a
    // small fraction of that.
    const adversarial = '<html><body>' + '<'.repeat(200_000);
    const parseSpy = vi.spyOn(Readability.prototype, 'parse');
    const t0 = Date.now();
    const r = await fetchWith(adversarial, 'https://example.com/adversarial');
    const elapsed = Date.now() - t0;
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('simplified extraction');
    expect(parseSpy).not.toHaveBeenCalled(); // guard still stopped Readability, not just stripToText
    expect(elapsed).toBeLessThan(1000); // was 12,194ms before the fix
    parseSpy.mockRestore();
  });

  it('does not freeze when the complexity guard itself scans ~5MB of unterminated "<a" tags (CRITICAL regression, guard tagRe)', async () => {
    // WHY this exact shape (2026-08-06 re-review, finding "IMPORTANT — the
    // guard's own tagRe is quadratic"): tooComplexToExtract's OLD depth-scan
    // regex (/<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*?(\/?)>/g) is what froze here —
    // NOT stripToText, which the previous round already fixed. The tag-COUNT
    // pre-check (which just counts raw '<' characters) does not save it:
    // 14,999 is deliberately just under MAX_TAGS (15,000), so this input
    // reaches the depth scan. There is no '>' anywhere in the ~5MB document,
    // so the old lazy-quantifier regex fails at every one of the 14,999 '<a'
    // starts and retries at every subsequent character, each retry
    // re-scanning to the (nonexistent) end. Measured directly against the old
    // regex on this exact shape: 9,965ms, entirely inside
    // WebFetchTool.execute, before Readability is ever reached.
    const filler = 'x'.repeat(340); // pads to ~5MB while keeping the '<' count (14,999) under MAX_TAGS
    const adversarial = ('<a ' + filler).repeat(14_999);
    const t0 = Date.now();
    const r = await fetchWith(adversarial, 'https://example.com/adversarial-guard');
    const elapsed = Date.now() - t0;
    expect(typeof r.text).toBe('string'); // never an uncaught throw
    expect(elapsed).toBeLessThan(1000); // was 9,965ms before the fix
  });

  it('does not misjudge depth on a comment body whose lowercase fold changes length (CRITICAL regression, round 3)', async () => {
    // WHY this exact shape (2026-08-06 round-3 review): the guard's depth scan
    // used to build one `lower = html.toLowerCase()` copy and index it with
    // offsets computed against `html`'s own length. That is only safe if
    // lowercasing never changes length, which is false for some codepoints —
    // 'İ'.toLowerCase() (U+0130) is TWO UTF-16 units. A 200,000-char comment
    // body of 'İ' makes `lower` 200,000 units longer than `html`, so the
    // comment-close search (run against `lower`) finds '-->' at an index that
    // overshoots the SAME position in `html` by 200,000 characters — the
    // cursor skips straight over the 1,000-deep <div> nest that follows,
    // the guard measures depth < 150, and Readability runs on a document
    // that is ACTUALLY 1,000 deep. Measured directly against the OLD
    // (aliased) guard logic on this exact payload: it returned "not too
    // complex" in 5ms, i.e. it let the page through. Verified as a real
    // regression at e1eee255^ (before this file's round-1 fix): the same
    // payload was rejected by the guard in 3ms with Readability never
    // called. The fix removes the second string entirely (see indexOfFold's
    // WHY comment) so there is only ever one index space.
    const payload = '<!--' + 'İ'.repeat(200_000) + '-->' + '<div>'.repeat(1000) + 'x' + '</div>'.repeat(1000);
    const parseSpy = vi.spyOn(Readability.prototype, 'parse');
    const t0 = Date.now();
    const r = await fetchWith(`<html><body>${payload}</body></html>`, 'https://example.com/aliasing');
    const elapsed = Date.now() - t0;
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/too large or deeply nested/);
    expect(r.text).toContain('simplified extraction');
    expect(parseSpy).not.toHaveBeenCalled(); // guard must reject BEFORE Readability, not discover the hang inside it
    expect(elapsed).toBeLessThan(1000); // was 8,376ms before the fix (Readability ran on an actually-1000-deep doc)
    parseSpy.mockRestore();
  });

  it('does not freeze on 5MB of bare "<" characters (guard tag-count pre-check)', async () => {
    // WHY (task requirement): the cheapest possible adversarial shape for the
    // tag-count pre-check itself — pure '<' repeated to the body cap. This
    // pins that the O(n) /</g pre-check (never the quadratic part, but worth
    // a floor test) keeps this instant even at the full 5MB cap.
    const adversarial = '<'.repeat(5 * 1024 * 1024);
    const t0 = Date.now();
    const r = await fetchWith(adversarial, 'https://example.com/bare-lt');
    const elapsed = Date.now() - t0;
    expect(typeof r.text).toBe('string');
    expect(elapsed).toBeLessThan(1000);
  });

  it('discloses the fallback char cap when the too-complex page exceeds it', async () => {
    // The adversarial body above (200,012 chars) is just past FALLBACK_CHAR_CAP
    // (200,000), so the guard-path fallback must say it only scanned a prefix —
    // the fallback exists to give the model something useful, not to silently
    // render an entire multi-megabyte document as plain text.
    const adversarial = '<html><body>' + '<'.repeat(200_000);
    const r = await fetchWith(adversarial, 'https://example.com/adversarial-cap');
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/first 200KB/);
  });

  it('appends the 5MB truncation notice on the too-complex fallback path too', async () => {
    // Important finding (2026-08-06 review): every OTHER return path appends
    // "[body truncated at 5MB]" when readBodyCapped cut the body short; the
    // too-complex fallback used to skip it, so a 7MB tag-heavy page silently
    // returned a prefix with no sign 2MB+ were discarded — inside the exact
    // code path whose purpose is eliminating silent truncation.
    // Body shaped to (a) exceed 5MB so readBodyCapped truncates it, and (b)
    // still trip the tag-count guard after truncation (repeating tags keep
    // tagCount high throughout).
    const oversized = '<html><body>' + '<div>x</div>'.repeat(500_000); // ~6MB
    __setWebFetchTestHooks({
      lookup: publicLookup,
      fetchImpl: async () => html(oversized),
    });
    const r = await WebFetchTool.execute({ url: 'https://example.com/huge' } as any, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('simplified extraction');
    expect(r.text).toContain('[body truncated at 5MB]');
    // sanity: readBodyCapped really did cut it down from the ~6MB source
    expect(r.text.length).toBeLessThan(oversized.length);
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

describe('looksJsRendered', () => {
  it('flags the VitePress page whose content never reaches an HTTP client', () => {
    // 98KB of HTML carrying 5.2KB of text and __VP_HASH_MAP__. Detection here
    // rests on the __VP_HASH_MAP__ marker alone: this fixture's <div id="app">
    // is NOT empty (VitePress hydrates into it, so the raw HTML has real
    // children under it), so EMPTY_ROOT does not match it — verified directly
    // against this fixture (Minor finding, 2026-08-06 review; the old version
    // of this comment claimed "an empty app root", which was never true for
    // this file). A reviewing model asked this page about `include`, got a
    // confident preamble, and concluded the docs do not document it.
    expect(looksJsRendered(fixture('vitest-config.html'))).toBe(true);
  });

  it('does NOT flag a server-rendered docs page of similar shape', () => {
    // Same tool, same extraction ratio (69% vs 70%) — the discriminator has to be
    // text density plus framework markers, not coverage.
    expect(looksJsRendered(fixture('asyncio.html'))).toBe(false);
  });

  it('does not flag a small plain page', () => {
    expect(looksJsRendered('<html><body><h1>Hi</h1><p>Some words here.</p></body></html>')).toBe(false);
  });

  it('does not flag an SSR page whose density only looks low because of a hydration blob', () => {
    // Important finding (2026-08-06 review): stripToText already excludes
    // <script> bodies from the NUMERATOR, but the OLD denominator was raw
    // html.length, which still counted them — so a routine Next.js-style
    // __NEXT_DATA__ hydration blob could deflate density below the floor even
    // though every word of visible prose is present and server-rendered. This
    // simulates exactly that: full article content plus a large, normal
    // hydration blob. Measured: 7.31% under the old (buggy) denominator —
    // which WOULD have been flagged — vs 89.29% under the fixed one.
    const prose = '<article><h1>Guide</h1>'
      + '<p>Real server-rendered paragraph content that is complete and present. </p>'.repeat(60)
      + '</article>';
    const blob = 'x'.repeat(52_000);
    const ssrPage = `<html><body><div id="__next">${prose}</div>`
      + `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":"${blob}"}}</script>`
      + '</body></html>';
    expect(looksJsRendered(ssrPage)).toBe(false);
  });
});

describe('resolveFragment', () => {
  const html = fixture('vitest-config.html');

  it('reports a fragment the served HTML never contained', () => {
    // id="include" appears nowhere in the 98KB. This is the exact case that
    // produced a confident false negative in the 2026-08-01 review.
    expect(resolveFragment(html, '## Config Options\n\ntext', 'include').kind).toBe('absent');
  });

  it('reports a fragment present in the HTML but missing from the extraction', () => {
    expect(resolveFragment(html, '# Nothing relevant here', 'config-options').kind).toBe('dropped');
  });

  it('returns the section when the fragment survived extraction', () => {
    // Heading text carries a trailing anchor link in VitePress output
    // (`## Config Options [​](#config-options)`), so matching MUST go through the
    // anchor href, not a slug of the heading text. Verified 2026-08-06.
    const md = '## Intro\n\nfirst\n\n## Config Options [​](#config-options)\n\nthe body\n\n## After\n\nlast';
    const r = resolveFragment(html, md, 'config-options');
    expect(r.kind).toBe('found');
    if (r.kind === 'found') {
      expect(r.section).toContain('the body');
      expect(r.section).not.toContain('last');
      expect(r.exactCase).toBe(true);
    }
  });

  // --- broadened anchor-form scan (Important finding, 2026-08-06 review) ---
  // The old scan was /\sid="([^"]+)"/gi — double-quoted only, so single-quoted
  // id='x', unquoted id=x, and legacy <a name="x"> all missed silently, and
  // the resulting `absent` was reported to the model as a categorical "this
  // anchor does not exist". These pin the broadened scan against each form.

  it('finds a single-quoted id', () => {
    const page = "<html><body><h2 id='alpha'>Alpha</h2></body></html>";
    expect(resolveFragment(page, '## Alpha', 'alpha').kind).not.toBe('absent');
  });

  it('finds an unquoted id', () => {
    const page = '<html><body><h2 id=beta>Beta</h2></body></html>';
    expect(resolveFragment(page, '## Beta', 'beta').kind).not.toBe('absent');
  });

  it('finds a legacy <a name="..."> anchor', () => {
    const page = '<html><body><a name="gamma"></a><h2>Gamma</h2></body></html>';
    expect(resolveFragment(page, '## Gamma', 'gamma').kind).not.toBe('absent');
  });

  // --- case sensitivity (Minor finding, 2026-08-06 review) ---
  // HTML id is case-sensitive; the old code lowercased both sides
  // unconditionally, so "#Foo" could falsely resolve against id="foo".

  it('matches an id exactly by case, and does not treat different-case ids as a match by default', () => {
    const page = '<html><body><h2 id="Foo">Foo</h2><h2 id="foo">also foo</h2></body></html>';
    const r = resolveFragment(page, '## Foo', 'Foo');
    expect(r.kind).toBe('found');
    if (r.kind === 'found') expect(r.exactCase).toBe(true);
  });

  it('falls back to a case-insensitive match and reports it as such', () => {
    const page = '<html><body><h2 id="Foo">Foo</h2></body></html>';
    const r = resolveFragment(page, '## Foo', 'foo'); // requested lowercase, served id is "Foo"
    expect(r.kind).toBe('found');
    if (r.kind === 'found') expect(r.exactCase).toBe(false);
  });

  // --- truncation-aware wording (Important finding, 2026-08-06 review) ---
  // `absent` used to be a flat "this anchor does not exist" regardless of
  // whether the body was cut off at the 5MB cap — a categorical claim about
  // bytes that, when truncated, were never read.

  it('reports bodyTruncated: false when the full document was examined', () => {
    const r = resolveFragment('<html><body>no anchors here</body></html>', '', 'missing');
    expect(r).toEqual({ kind: 'absent', bodyTruncated: false });
  });

  it('reports bodyTruncated: true when the caller says the body was cut off', () => {
    const r = resolveFragment('<html><body>no anchors here</body></html>', '', 'missing', true);
    expect(r).toEqual({ kind: 'absent', bodyTruncated: true });
  });

  it('resolves quickly against thousands of <a> tags with no name= (regression floor, was ANCHOR_NAME_RE)', () => {
    // WHY this shape is still pinned (round 3): the ORIGINAL defect here was
    // ANCHOR_NAME_RE, a hand-rolled regex that retried at every <a lacking
    // name=, each retry re-scanning forward — 9,810ms on a comparable 5.14MB
    // body vs 59ms with no fragment. That regex is long gone (fragment
    // resolution is DOM-based now — see findAnchor in web-fetch.ts), but this
    // test stays as a floor: linkedom's real parse + querySelectorAll over
    // thousands of real <a> elements must ALSO stay well under a second, or a
    // future change could reintroduce a slow path here.
    const unit = '<a href="#">' + 'x'.repeat(660) + '</a>';
    const body = '<html><body>' + unit.repeat(7000) + '</body></html>';
    const t0 = Date.now();
    const r = resolveFragment(body, '# nothing relevant', 'section');
    const elapsed = Date.now() - t0;
    expect(r.kind).toBe('absent');
    expect(elapsed).toBeLessThan(1000); // was ~9,810ms with the old regex before the original fix
  });

  // --- DOM-based fragment resolution (design change, round 3, 2026-08-06) ---
  // Fragment resolution no longer hand-scans raw HTML at all: it queries the
  // SAME linkedom document htmlToMarkdown builds for Readability (see
  // findAnchor in web-fetch.ts). These pin the findings that motivated the
  // switch — cases where the old hand-rolled scan (walkTags + parseAttrs)
  // was demonstrably wrong, all fixed for free by asking a real parser.

  it('finds an id on a <script> element\'s own opening tag (IMPORTANT — script/style attrs were discarded)', () => {
    // On the committed vitest-config.html, id="check-dark-mode" and
    // id="check-mac-os" live on <script id="..."> elements. The old walkTags
    // `continue`d past script/style tags WITHOUT calling onTag, discarding
    // the opening tag's own attributes along with its body — so the
    // collector found only 10 of the fixture's 12 ids and WebFetch reported
    // "the HTML contains no anchor named check-dark-mode" about an id that
    // genuinely exists. linkedom parses a <script id="..."> element's
    // attributes like any other element, so this is fixed for free.
    const r = resolveFragment(html, '# irrelevant heading', 'check-dark-mode');
    expect(r.kind).not.toBe('absent');
  });

  it('the WebFetchTool pipeline no longer falsely denies an id that lives on a <script> tag', async () => {
    // End-to-end version of the case above, through the exact code path the
    // finding described: fetching vitest.dev/config/#check-dark-mode used to
    // emit a categorical "the HTML served for this URL contains no anchor
    // named check-dark-mode" — false, since the id exists (just not as a
    // markdown heading, so the honest verdict is "dropped", not "absent").
    // NOTE: uses fetchWith (module-scope `html` Response-builder), not the
    // bare `html` identifier — this describe block shadows it with the
    // fixture string above.
    const r = await fetchWith(html, 'https://example.com/config#check-dark-mode');
    expect(r.isError).toBeFalsy();
    expect(r.text).not.toMatch(/contains no anchor named/);
  });

  it('finds an id past a `>` inside a different attribute\'s quoted value (IMPORTANT — old scan truncated the tag)', () => {
    // <a title="a>b" id="realid"> and a sibling with an onclick handler
    // containing `>` both lost every attribute after the stray `>` under the
    // old hand-rolled tag walker (it took the first `>` as the tag's end,
    // full stop). Both are legal HTML5. linkedom's real parser tracks quote
    // state, so this is fixed for free.
    const page = '<html><body><a title="a>b" id="realid"></a><div onclick="if(a>b)f()" id="clickid"></div></body></html>';
    expect(resolveFragment(page, '# irrelevant', 'realid').kind).not.toBe('absent');
    expect(resolveFragment(page, '# irrelevant', 'clickid').kind).not.toBe('absent');
  });

  it('does NOT fabricate an anchor from an id inside a <textarea> (MINOR — raw-text elements)', () => {
    // <textarea>, <title>, and <xmp> are raw-text elements: their content is
    // never parsed as child elements by a real browser or by linkedom, even
    // though it's tag-shaped text. The old walkTags only special-cased
    // script/style, so `<textarea><a id="tafake"></textarea>` produced a
    // fabricated "the page has an anchor named tafake, but extraction didn't
    // keep it" for an id that was never a real element. Realistic vector:
    // any page that echoes user-submitted markup into a form field.
    const page = '<html><body><textarea><a id="tafake"></textarea></body></html>';
    expect(resolveFragment(page, '# irrelevant', 'tafake').kind).toBe('absent');
  });

  it('re-measures the id count with the collector itself, not grep (round-2 process note)', () => {
    // The round-2 report claimed collector/HTML parity by running
    // `grep -o 'id="[^"]*"' | wc -l`, which measures grep, not the collector
    // that changed. Fragment resolution's "collector" as of round 3 is
    // linkedom's own parsed DOM (the same one WebFetch queries via
    // findAnchor) — so the correct re-measurement queries THAT, and then
    // proves every id it finds actually resolves through the exported
    // resolveFragment, not just that the counts happen to match.
    const { document } = parseHTML(html);
    const ids = new Set<string>();
    for (const el of document.querySelectorAll('[id]')) {
      const id = el.getAttribute('id');
      if (id) ids.add(id);
    }
    expect(ids.size).toBe(12); // grep -o 'id="[^"]*"' tests/fixtures/web/vitest-config.html | sort -u | wc -l
    for (const id of ids) {
      expect(resolveFragment(html, '# irrelevant heading', id).kind).not.toBe('absent');
    }
  });

  // --- false-anchor scoping (Important finding, 2026-08-06 re-review) ---
  // The old \bid\s*= regex matched id= as a bare substring anywhere in the raw
  // HTML, so each of these produced a fabricated anchor that flipped a correct
  // `absent` verdict into a false `dropped` claim ("the page has an anchor
  // named X, but extraction did not keep that section"). Each must report
  // `absent`, never `dropped` — dropped means "id= was really matched but the
  // section vanished during extraction", which is not what happened here.

  it('does not treat data-id= as a real anchor id', () => {
    const page = '<html><body><div data-id="ghost">text</div></body></html>';
    expect(resolveFragment(page, '# Nothing relevant', 'ghost').kind).toBe('absent');
  });

  it('does not treat an id= inside a different attribute\'s value (href query string) as a real anchor id', () => {
    const page = '<html><body><a href="/page?id=42">link</a></body></html>';
    expect(resolveFragment(page, '# Nothing relevant', '42').kind).toBe('absent');
  });

  it('does not treat id= assigned inside a <script> body as a real anchor id', () => {
    const page = '<html><body><script>el.id = "jsassigned"; var s = "id=leaked";</script></body></html>';
    expect(resolveFragment(page, '# Nothing relevant', 'jsassigned').kind).toBe('absent');
  });

  it('does not treat id= written inside an HTML comment as a real anchor id', () => {
    const page = '<html><body><!-- id="commented" --><p>text</p></body></html>';
    expect(resolveFragment(page, '# Nothing relevant', 'commented').kind).toBe('absent');
  });
});
