#!/usr/bin/env node
// Probe the Exa keyless hosted MCP endpoint (https://mcp.exa.ai/mcp) as a plain
// HTTPS JSON-RPC client — no MCP framework. Run on every search-backend change
// and record the observed shapes in docs/provider-dependencies.md.
// Usage: node test-search/probe-exa.mjs "your query" [--key EXA_KEY] [--out fixture.json]
//
// OBSERVED (2026-07-16, keyless): NO handshake is required. A stateless
// tools/call on the bare https://mcp.exa.ai/mcp endpoint returns HTTP 200 with
// a full result — the initialize path below is kept only as a fallback in case
// the server later starts demanding a session. Details of the working path:
//   - transport: SSE-framed ("event: message\ndata: {json}\n\n"), NOT plain JSON.
//   - tool name: web_search_exa, arguments { query, numResults }.
//   - JSON-RPC result path: result.content[0] = { type:"text", text:<string>,
//     _meta:{ searchTime } }. content[0].text is a HUMAN-READABLE PLAIN-TEXT
//     block, NOT a JSON string — the parser must scrape it, not JSON.parse it.
//     Each result is separated by "\n\n---\n\n" and formatted as:
//         Title: <title>
//         URL: <url>
//         Published: <ISO date | "N/A">
//         Author: <author | "N/A">
//         Highlights:
//         <snippet/highlight text, may span multiple lines>
//   - result.isError is absent on success (a tool-level error would set it true
//     with the message inside content[0].text — still a 200 at the RPC layer).
const args = process.argv.slice(2);
const query = args.find((a) => !a.startsWith('--')) ?? 'latest Node.js LTS version';
const key = args.includes('--key') ? args[args.indexOf('--key') + 1] : null;
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const base = 'https://mcp.exa.ai/mcp' + (key ? `?exaApiKey=${encodeURIComponent(key)}` : '');
const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

// Streamable-HTTP MCP responses may arrive as plain JSON or as an SSE frame
// ("event: message\ndata: {...}"). Handle both and report which we saw.
function parseBody(text) {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) return { mode: 'json', body: JSON.parse(t) };
  const data = t.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
  return { mode: 'sse', body: JSON.parse(data) };
}

async function rpc(method, params, id, sessionId) {
  const res = await fetch(base, {
    method: 'POST',
    headers: { ...HEADERS, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
    // A notification has no id; omit it so the server treats it as fire-and-forget.
    body: JSON.stringify(id === undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  return { status: res.status, sessionId: res.headers.get('mcp-session-id'), text };
}

// Attempt 1: stateless tools/call (some hosted MCP servers allow it).
console.log('--- attempt: stateless tools/call ---');
let r = await rpc('tools/call', { name: 'web_search_exa', arguments: { query, numResults: 3 } }, 1);
console.log('status:', r.status);
console.log(r.text.slice(0, 4000));
let parsed = null;
try { parsed = parseBody(r.text); } catch { /* not parseable — fall through */ }

if (!parsed || parsed.body.error) {
  // Attempt 2: full handshake — initialize (capture mcp-session-id) →
  // notifications/initialized → tools/call. mcp.exa.ai REQUIRES this.
  console.log('--- attempt: initialize handshake ---');
  const init = await rpc('initialize', {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'youcoded-probe', version: '0.0.0' },
  }, 0);
  console.log('initialize status:', init.status, 'mcp-session-id:', init.sessionId);
  console.log(init.text.slice(0, 2000));
  // The spec-mandated post-initialize notification. Without it mcp.exa.ai still
  // answers tools/call, but send it to mirror a compliant client exactly.
  const note = await rpc('notifications/initialized', {}, undefined, init.sessionId);
  console.log('notifications/initialized status:', note.status);
  r = await rpc('tools/call', { name: 'web_search_exa', arguments: { query, numResults: 3 } }, 1, init.sessionId);
  console.log('tools/call status:', r.status);
  console.log(r.text.slice(0, 4000));
  parsed = parseBody(r.text);
}

if (parsed.body.error) { console.error('FAIL:', JSON.stringify(parsed.body.error)); process.exit(1); }
if (parsed.body.result?.isError) { console.error('FAIL: tool-level error:', parsed.body.result.content?.[0]?.text); process.exit(1); }
if (out) (await import('fs')).writeFileSync(out, JSON.stringify(parsed.body, null, 2));
// content[0].text is a plain-text block, NOT JSON — surface how many result
// records the scraper would find (Title:/URL: blocks split on "---") so inner
// drift is visible from the probe alone.
const text = parsed.body.result?.content?.[0]?.text ?? '';
const records = text.split(/\n\s*---\s*\n/).filter((b) => /^\s*Title:/m.test(b));
console.log('result.content[0].text records (Title:/URL: blocks):', records.length);
console.log('first record fields present:', ['Title:', 'URL:', 'Published:', 'Author:', 'Highlights:'].filter((f) => records[0]?.includes(f)).join(' '));
console.log('PASS: transport mode =', parsed.mode, '— handshake required: NO (stateless works). Record the plain-text result shape in provider-dependencies.md');
