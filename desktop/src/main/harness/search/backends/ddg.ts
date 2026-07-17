// DuckDuckGo HTML search backend — the last, keyless fallback of the chain.
// Shape pinned by tests/fixtures/search/* captured via test-search/probe-*.mjs
// (2026-07-16). See tests/search-backends.test.ts.
//
// WHAT the probe found (test-search/probe-ddg.mjs):
//   - Endpoint https://html.duckduckgo.com/html/?q=<enc>, User-Agent: YouCoded.
//   - HTTP 202 = rate-limited. This is DDG's documented throttle response and
//     must NEVER be retry-hammered — mark it permanent so the chain moves on.
//   - Each result's title/link is an <a class="result__a" href="..."> whose href
//     is a REDIRECT WRAPPER: //duckduckgo.com/l/?uddg=<url-encoded target>&rut=…
//     Note the "&" is HTML-escaped as "&amp;" in the raw HTML — we HTML-unescape
//     the href, then read the `uddg` param and decode it to the real target URL.
//   - Snippets are <a class="result__snippet">…</a>.
//   - Titles/snippets contain entities (&amp; &lt; &gt; &quot; &#x27;) and nested
//     <b> tags — we strip tags and decode entities to clean human text.
import { SearchBackend, SearchBackendError, SearchResult } from './types';

const HOST = 'html.duckduckgo.com';
const MAX_RESULTS = 8;

// Convert a numeric code point to a character, but ONLY if it's a valid Unicode
// scalar. WHY: the HTML is untrusted — a title with "&#x110000;" or "&#99999999;"
// would make String.fromCodePoint throw a raw RangeError that escapes search()
// and bypasses the SearchBackendError contract. On out-of-range we leave the
// original entity text untouched rather than crash the last-resort backend.
function codePointToChar(literal: string, cp: number): string {
  return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : literal;
}

// Decode the small set of HTML entities DDG emits, plus generic numeric refs.
// &amp; is decoded LAST so an already-decoded "&" is never re-interpreted.
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => codePointToChar(m, parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => codePointToChar(m, parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

// Strip any HTML tags (e.g. the <b>…</b> query-term highlights) then decode
// entities, yielding clean display text.
function cleanText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// Turn a DDG redirect href into the real destination URL, or null if it isn't a
// wrapper we recognise. The href looks like
//   //duckduckgo.com/l/?uddg=<encoded target>&amp;rut=<hash>
// or a direct http(s) URL when DDG omits the wrapper entirely.
function resolveRedirect(rawHref: string): string | null {
  // HTML-unescape first so "&amp;" becomes a real "&" query separator.
  const href = decodeEntities(rawHref);
  try {
    // href starts with "//" (protocol-relative); give it a scheme so URL parses.
    const target = new URL(href.startsWith('//') ? `https:${href}` : href).searchParams.get('uddg');
    if (target && /^https?:/i.test(target)) return target;
  } catch {
    /* not a parseable URL — fall through */
  }
  // Some DDG variants return a DIRECT link with no uddg wrapper. Don't drop it —
  // dropping every anchor while anchors EXIST would return [] (a fake "no
  // results") because the markup-drift guard never fires.
  if (/^https?:\/\//i.test(href)) return href;
  return null;
}

export const ddgBackend: SearchBackend = {
  id: 'ddg',
  async search(query, { signal, fetchImpl = fetch }) {
    const url = `https://${HOST}/html/?q=${encodeURIComponent(query)}`;

    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { 'User-Agent': 'YouCoded' }, signal });
    } catch (err) {
      // NEVER swallow an abort — rethrow the caller's cancellation untouched.
      if (signal.aborted) throw err;
      throw new SearchBackendError(`Could not reach ${HOST} — check the network connection.`);
    }

    // 202 is DDG's rate-limit signal — permanent so the chain never retries it.
    if (res.status === 202) {
      throw new SearchBackendError('DuckDuckGo is rate-limiting requests from this network right now.', true);
    }
    if (!res.ok) throw new SearchBackendError(`DuckDuckGo answered HTTP ${res.status}.`);

    const html = await res.text();

    // Pull each result's title anchor (href + inner HTML). `class` precedes
    // `href` in the markup, so match class first then the href attribute.
    const anchorRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const anchors: { href: string; titleHtml: string; end: number }[] = [];
    for (let m = anchorRe.exec(html); m; m = anchorRe.exec(html)) {
      anchors.push({ href: m[1], titleHtml: m[2], end: anchorRe.lastIndex });
    }

    // Zero anchors on a 2xx page means DDG changed its markup — say so plainly
    // rather than returning an empty list that looks like "no results".
    if (anchors.length === 0) {
      throw new SearchBackendError("DuckDuckGo's result markup changed — the fallback parser needs updating.", true);
    }

    // Collect snippet anchors with their positions so each can be matched to the
    // title that precedes it (a result may occasionally lack a snippet).
    const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const snippets: { html: string; start: number }[] = [];
    for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) {
      snippets.push({ html: m[1], start: m.index });
    }

    const results: SearchResult[] = [];
    for (let i = 0; i < anchors.length && results.length < MAX_RESULTS; i++) {
      const target = resolveRedirect(anchors[i].href);
      if (!target) continue; // skip anything that isn't a real destination link
      const nextEnd = i + 1 < anchors.length ? anchors[i + 1].end : Infinity;
      // The snippet for this result sits between this title and the next one.
      const snippetHtml = snippets.find((s) => s.start > anchors[i].end && s.start < nextEnd)?.html;
      const title = cleanText(anchors[i].titleHtml) || target;
      const snippet = snippetHtml ? cleanText(snippetHtml) : '';
      results.push({ title, url: target, ...(snippet ? { snippet } : {}) });
    }
    return results;
  },
};
