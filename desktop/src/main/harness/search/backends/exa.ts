// Exa search backend — the keyless default of the WebSearch chain.
// Shape pinned by tests/fixtures/search/* captured via test-search/probe-*.mjs
// (2026-07-16). See tests/search-backends.test.ts.
//
// WHAT the probe found (test-search/probe-exa.mjs):
//   - Endpoint https://mcp.exa.ai/mcp is a stateless JSON-RPC 2.0 MCP server:
//     a bare tools/call works with NO initialize handshake and no session id.
//   - The HTTP body is SSE-framed ("event: message\ndata: {json}\n\n"), though
//     it may also arrive as plain JSON — we handle BOTH defensively.
//   - Success payload: result.content[0].text is a HUMAN-READABLE PLAIN-TEXT
//     block (NOT JSON): records separated by "\n\n---\n\n", each formatted as
//         Title: <title>
//         URL: <url>
//         Published: <date | N/A>
//         Author: <author | N/A>
//         Highlights:
//         <snippet text, may span multiple lines>
//   - A tool-level failure is still HTTP 200 but sets result.isError:true with
//     the message inside content[0].text.
//   - A JSON-RPC failure returns an { error } object instead of a result.
//   - An API key (optional) rides on the URL as ?exaApiKey=<key>.
import { SearchBackend, SearchBackendError, SearchResult } from './types';

const ENDPOINT = 'https://mcp.exa.ai/mcp';
const HOST = 'mcp.exa.ai';
const MAX_RESULTS = 8;

// Streamable-HTTP MCP responses arrive as plain JSON or as an SSE stream. A
// stream can carry MORE THAN ONE event (e.g. a progress/notification frame
// before the result frame) — we must NOT concatenate every data: line and parse
// once, or a legal multi-event response corrupts into "{...}{...}" and throws.
// Instead: split on blank-line event boundaries; within one event join its
// data: lines with "\n" (SSE spec); parse each event independently; return the
// LAST event whose data is a JSON-RPC response carrying `result` or `error`.
// Frames that parse to neither (bare notifications) are ignored. Mirrors
// parseBody() in test-search/probe-exa.mjs.
function parseBody(text: string): any {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) return JSON.parse(t);
  let selected: any = null;
  for (const event of t.split(/\r?\n\r?\n/)) {
    // Join this event's data: lines with "\n" and strip one optional leading
    // space per the SSE field-value rule (don't trim — that could corrupt a
    // multi-line JSON string value).
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    let parsed: any;
    try { parsed = JSON.parse(data); } catch { continue; } // not JSON — skip this frame
    if (parsed && (Object.prototype.hasOwnProperty.call(parsed, 'result') || Object.prototype.hasOwnProperty.call(parsed, 'error'))) {
      selected = parsed; // keep the last response frame in the stream
    }
  }
  if (selected === null) throw new Error('no JSON-RPC response frame found in the SSE stream');
  return selected;
}

// Scrape the plain-text result block into structured records. We only need the
// Title and URL to build a result; Highlights becomes the optional snippet.
function parseRecords(text: string): SearchResult[] {
  const results: SearchResult[] = [];
  // Records are separated by a "---" divider line (tolerate surrounding space).
  for (const block of text.split(/\n\s*---\s*\n/)) {
    const title = block.match(/^\s*Title:\s*(.*)$/m)?.[1]?.trim();
    const url = block.match(/^\s*URL:\s*(.*)$/m)?.[1]?.trim();
    // Skip anything without a usable http(s) URL — a record with no link is not
    // a result we can hand back to the model.
    if (!url || !/^https?:/i.test(url)) continue;
    // Everything after the "Highlights:" label (to the end of the record) is the
    // snippet; it may be absent or span multiple lines.
    const highlights = block.match(/^\s*Highlights:\s*\n([\s\S]*)$/m)?.[1]?.trim();
    results.push({ title: title || url, url, ...(highlights ? { snippet: highlights } : {}) });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

export const exaBackend: SearchBackend = {
  id: 'exa',
  async search(query, { key, signal, fetchImpl = fetch }) {
    // The key (if any) is a URL query param, not a header.
    const url = key ? `${ENDPOINT}?exaApiKey=${encodeURIComponent(key)}` : ENDPOINT;
    const requestBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'web_search_exa', arguments: { query, numResults: MAX_RESULTS } },
    });

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: requestBody,
        signal,
      });
    } catch (err) {
      // NEVER swallow an abort — the caller cancelled on purpose; rethrow as-is.
      if (signal.aborted) throw err;
      throw new SearchBackendError(`Could not reach ${HOST} — check the network connection.`);
    }

    if (!res.ok) throw new SearchBackendError(`Exa answered HTTP ${res.status}.`);

    let body: any;
    try {
      // res.text() is inside the try too: a timeout/cancel DURING the body read
      // surfaces here, and must propagate as the abort — not a parse failure.
      body = parseBody(await res.text());
    } catch (err) {
      if (signal.aborted || (err as { name?: string })?.name === 'AbortError') throw err;
      throw new SearchBackendError('Exa returned a response this app could not parse.');
    }

    // JSON-RPC-level failure: surface the server's own message verbatim.
    if (body?.error) throw new SearchBackendError(String(body.error.message ?? 'Exa reported a JSON-RPC error.'));
    // Tool-level failure: still HTTP 200, message lives in the text content.
    if (body?.result?.isError) {
      const detail = body.result.content?.[0]?.text;
      throw new SearchBackendError(detail ? String(detail) : 'Exa reported a tool-level error.');
    }

    const text = body?.result?.content?.[0]?.text;
    if (typeof text !== 'string') {
      throw new SearchBackendError("Exa's result format changed — the parser needs updating.", true);
    }
    return parseRecords(text);
  },
};
