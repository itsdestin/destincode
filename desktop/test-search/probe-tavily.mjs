#!/usr/bin/env node
// Probe Tavily /search. Requires a key: node test-search/probe-tavily.mjs --key tvly-xxx ["query"]
const args = process.argv.slice(2);
const key = args.includes('--key') ? args[args.indexOf('--key') + 1] : null;
const query = args.find((a) => !a.startsWith('--') && !a.startsWith('tvly')) ?? 'latest Node.js LTS version';
if (!key) { console.log('SKIP: no --key provided. Documented shape: POST https://api.tavily.com/search, Authorization: Bearer, {query,max_results} -> {results:[{title,url,content}]}'); process.exit(0); }
const res = await fetch('https://api.tavily.com/search', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({ query, max_results: 3 }),
  signal: AbortSignal.timeout(15_000),
});
console.log('status:', res.status);
console.log((await res.text()).slice(0, 3000));
