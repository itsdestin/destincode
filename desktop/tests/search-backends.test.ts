import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { exaBackend } from '../src/main/harness/search/backends/exa';
import { ddgBackend } from '../src/main/harness/search/backends/ddg';
import { tavilyBackend } from '../src/main/harness/search/backends/tavily';
import { SearchBackendError } from '../src/main/harness/search/backends/types';

const fixture = (f: string) => readFileSync(join(__dirname, 'fixtures', 'search', f), 'utf8');
const sig = () => new AbortController().signal;
const respond = (body: string, init?: ResponseInit) => (async () => new Response(body, init)) as typeof fetch;

describe('exa backend', () => {
  it('parses the captured keyless response into results', async () => {
    const results = await exaBackend.search('q', { key: null, signal: sig(), fetchImpl: respond(fixture('exa-response.json')) });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) { expect(r.title).toBeTruthy(); expect(r.url).toMatch(/^https?:/); }
  });
  it('appends exaApiKey when a key is present', async () => {
    let calledUrl = '';
    const f = (async (u: any) => { calledUrl = String(u); return new Response(fixture('exa-response.json')); }) as typeof fetch;
    await exaBackend.search('q', { key: 'exa-k', signal: sig(), fetchImpl: f });
    expect(calledUrl).toContain('exaApiKey=exa-k');
  });
  it('throws SearchBackendError on a JSON-RPC error payload', async () => {
    await expect(exaBackend.search('q', { key: null, signal: sig(), fetchImpl: respond('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"limited"}}') }))
      .rejects.toThrow(SearchBackendError);
  });

  // Extra: the RAW HTTP body from mcp.exa.ai is SSE-framed ("event: message\ndata: {...}\n\n").
  // The on-disk fixture is the already-SSE-decoded JSON-RPC body, so pin the SSE path
  // explicitly by wrapping that same fixture in an SSE frame and asserting identical output.
  it('parses an SSE-framed body identically to the plain-JSON body', async () => {
    const json = fixture('exa-response.json');
    const plain = await exaBackend.search('q', { key: null, signal: sig(), fetchImpl: respond(json) });
    const sse = 'event: message\ndata: ' + json.replace(/\n/g, '') + '\n\n';
    const framed = await exaBackend.search('q', { key: null, signal: sig(), fetchImpl: respond(sse) });
    expect(framed).toEqual(plain);
    expect(framed.length).toBeGreaterThan(0);
  });

  // Extra: a tool-level failure is HTTP 200 with result.isError:true — the honest
  // message lives in the text content, not in a JSON-RPC error object.
  it('throws SearchBackendError with the text content when result.isError is true', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'Exa: monthly quota exhausted' }] } });
    await expect(exaBackend.search('q', { key: null, signal: sig(), fetchImpl: respond(body) }))
      .rejects.toThrow(/quota exhausted/i);
  });
});

describe('ddg backend', () => {
  it('parses the captured HTML into results (uddg redirect decoded)', async () => {
    const results = await ddgBackend.search('q', { key: null, signal: sig(), fetchImpl: respond(fixture('ddg-response.html')) });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].url).not.toContain('duckduckgo.com/l/');
  });
  it('202 → honest rate-limit error, marked permanent (never retried)', async () => {
    await expect(ddgBackend.search('q', { key: null, signal: sig(), fetchImpl: respond('', { status: 202 }) }))
      .rejects.toThrow(/rate.?limit/i);
  });
  it('markup drift → explicit error, not empty garbage', async () => {
    await expect(ddgBackend.search('q', { key: null, signal: sig(), fetchImpl: respond('<html><body>totally different</body></html>') }))
      .rejects.toThrow(/markup|changed/i);
  });

  // Extra: DDG titles arrive with HTML entities (&#x27; &amp;) and <b> tags — the
  // parser must strip tags and decode entities so results carry clean human text.
  it('strips tags and decodes HTML entities in titles', async () => {
    const results = await ddgBackend.search('q', { key: null, signal: sig(), fetchImpl: respond(fixture('ddg-response.html')) });
    const decoded = results.find((r) => r.title.includes("What's New"));
    expect(decoded).toBeTruthy();
    expect(decoded!.title).toContain('& EOL');       // &amp; decoded
    expect(decoded!.title).not.toContain('&#x27;');  // numeric entity decoded
    expect(decoded!.title).not.toContain('&amp;');   // named entity decoded
    for (const r of results) { expect(r.title).not.toContain('<b>'); } // tags stripped
  });
});

describe('tavily backend', () => {
  it('parses the documented shape', async () => {
    const body = JSON.stringify({ results: [{ title: 'T', url: 'https://t.example', content: 'snippet' }, { title: 'no url row' }] });
    const results = await tavilyBackend.search('q', { key: 'tvly-x', signal: sig(), fetchImpl: respond(body) });
    expect(results).toEqual([{ title: 'T', url: 'https://t.example', snippet: 'snippet' }]);
  });
  it('requires a key', async () => {
    await expect(tavilyBackend.search('q', { key: null, signal: sig() })).rejects.toThrow(/key/i);
  });
  it('401 → key-rejected error', async () => {
    await expect(tavilyBackend.search('q', { key: 'bad', signal: sig(), fetchImpl: respond('', { status: 401 }) }))
      .rejects.toThrow(/key|rejected|unauthorized/i);
  });
});
