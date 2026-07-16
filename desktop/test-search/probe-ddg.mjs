#!/usr/bin/env node
// Probe DDG's HTML endpoint (the fallback backend). SINGLE attempt — a 202 is
// the documented rate-limit response and must NEVER be retry-hammered.
// Usage: node test-search/probe-ddg.mjs "your query" [--out fixture.html]
import fs from 'fs';
const args = process.argv.slice(2);
const query = args.find((a) => !a.startsWith('--')) ?? 'latest Node.js LTS version';
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
  headers: { 'User-Agent': 'YouCoded' },
  signal: AbortSignal.timeout(15_000),
});
console.log('status:', res.status);
const text = await res.text();
if (res.status === 202) { console.log('RATELIMITED (202) — this is the shape the backend must detect'); process.exit(0); }
const links = [...text.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs)];
const snippets = [...text.matchAll(/class="result__snippet"[^>]*>(.*?)<\/a>/gs)];
console.log('result__a count:', links.length, ' result__snippet count:', snippets.length);
console.log('first href:', links[0]?.[1]);
console.log('first title html:', links[0]?.[2]?.slice(0, 200));
if (out) fs.writeFileSync(out, text);
if (links.length === 0) { console.error('FAIL: no result__a anchors — DDG markup changed; update the parser + this probe'); process.exit(1); }
console.log('PASS — note whether hrefs are direct or //duckduckgo.com/l/?uddg=<encoded> redirects');
