// WebFetch (spec §3.1): guardedFetch → Readability extraction → Markdown →
// shared truncation. CC-compatible input shape {url, prompt?} so the existing
// WebFetchView renders unchanged (it markdown-renders the result string).
// DESIGN (plan decision 9): no secondary summarization model — the result IS
// the extracted markdown; `prompt` is echoed as a context header.
// DOM provider is linkedom (NOT domino/jsdom) — Task 1 verified readability
// 0.6.0 breaks on domino's non-iterable NodeLists.
import { z } from 'zod';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
// turndown ships no bundled types and @types/turndown isn't a dependency in this
// repo — suppress the implicit-any import here rather than add a shared
// devDependency or a new .d.ts file (plan: type accommodations stay in MY files
// only). linkedom and @mozilla/readability both ship their own types.
// Tried @ts-expect-error (the self-cleaning choice) first, but under THIS repo's
// tsconfig tsc does NOT error on the turndown import — turndown resolves to a .js
// with no adjacent .d.ts and skipLibCheck is on — so @ts-expect-error itself trips
// TS2578 "unused directive" and breaks the build. Reverted to @ts-ignore per that
// empirical outcome; it stays a defensive suppressor if the resolution ever changes.
// @ts-ignore -- no type declarations for 'turndown'
import TurndownService from 'turndown';
import { defineTool } from './registry';
import { guardedFetch, readBodyCapped, NetGuardError, type GuardedFetchOpts } from './net-guard';

const MAX_BODY_BYTES = 5 * 1024 * 1024;

// Test seam: unit tests inject lookup/fetch; production uses the real ones.
let testHooks: Pick<GuardedFetchOpts, 'lookup' | 'fetchImpl'> = {};
export function __setWebFetchTestHooks(h: typeof testHooks): void { testHooks = h; }

const inputSchema = z.object({
  url: z.string().describe('The URL to fetch (http/https only)'),
  prompt: z.string().optional().describe('What you want to learn from this page'),
});

const TEXT_TYPES = /^(text\/(plain|markdown|csv|xml)|application\/(json|xml|rss\+xml|atom\+xml))/;

// --- Pre-parse complexity guard (CRITICAL: main-thread DoS defense) ----------
// htmlToMarkdown() runs parseHTML → Readability.parse() → turndown ALL
// SYNCHRONOUSLY on the Electron MAIN event loop (NativeSessionHost executes tools
// on the main loop — there is no worker offload). Readability.parse() is roughly
// QUADRATIC in DOM nesting depth, so a small but pathological page freezes EVERY
// window, all IPC, and the live session for tens of seconds. Measured on this
// machine: 150-deep divs ~0.4s, 200-deep ~1.1s, 400-deep ~4.1s, 1000-deep ~53s;
// ~15k tags ~0.6s, ~120k tags ~5s. The 5MB byte cap does NOT bound this — parse
// cost scales with DOM STRUCTURE (depth/tag-count), not byte length (a 54KB file
// can hang for seconds). And defineTool's try/catch CANNOT save us: a synchronous
// hang never throws, so nothing unwinds. This O(n)-on-the-raw-string pre-check is
// therefore the ONLY guard — it must reject pathological input BEFORE it reaches
// Readability. Thresholds sit far above real articles (which nest ~8-60 and carry
// a few thousand tags) yet keep any page that PASSES under ~0.6s of parse time.
const MAX_DEPTH = 150;
const MAX_TAGS = 15_000;

// Void elements never open a nesting level (no close tag), so they must not
// increment depth or every <br>/<img>-heavy page would over-count.
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Cheap O(n) rejection of pathological HTML BEFORE the quadratic Readability
 *  parse. Returns an honest error message when the page is too broad or too
 *  deeply nested to extract safely; returns null when it is safe to proceed. */
function tooComplexToExtract(rawHtml: string): string | null {
  // Breadth proxy: count '<' across the whole string (includes text-node '<' and
  // comments — a deliberate cheap over-approximation). Bounds huge tables /
  // anchor lists whose cost comes from tag COUNT, not depth.
  const tagCount = (rawHtml.match(/</g) || []).length;
  if (tagCount > MAX_TAGS) {
    return 'WebFetch: this page is too large or deeply nested to extract safely. Try a more specific URL or a printer-friendly/article version.';
  }
  // Depth: single pass over tag matches, tracking a running open/close depth and
  // its max. Increment on a non-void, non-self-closed open tag; decrement on a
  // close tag; clamp at 0 so malformed close-heavy input can't underflow.
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*?(\/?)>/g;
  let depth = 0;
  let maxDepth = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(rawHtml)) !== null) {
    const isClose = m[1] === '/';
    const selfClosed = m[3] === '/';
    if (isClose) {
      depth = Math.max(0, depth - 1);
    } else if (!selfClosed && !VOID_ELEMENTS.has(m[2].toLowerCase())) {
      depth++;
      if (depth > maxDepth) maxDepth = depth;
    }
  }
  if (maxDepth > MAX_DEPTH) {
    return 'WebFetch: this page is too large or deeply nested to extract safely. Try a more specific URL or a printer-friendly/article version.';
  }
  return null;
}

/** Tag-strip to readable text — the guard-path fallback that runs on EXACTLY
 *  the input tooComplexToExtract() just rejected, so it must not reintroduce
 *  the freeze the guard exists to prevent.
 *
 *  WHY this is a hand-written scan and not a regex (CRITICAL, 2026-08-06
 *  review): the previous implementation used /<[^>]*>/g and
 *  /<script[\s\S]*?<\/script>/gi and its comment claimed this was O(n). That
 *  claim was never measured and is false: both regexes backtrack — when a '<'
 *  or '<script' is never followed by its terminator, the engine retries the
 *  match starting at every subsequent character, each retry re-scanning to the
 *  end of the string. Measured on this machine: /<[^>]*>/g against a run of
 *  200,000 unterminated '<' characters (200KB — far under the 5MB body cap)
 *  took 12,194ms. That exact shape (many '<' with no '>') is what makes
 *  tooComplexToExtract() reject a page in the first place (it counts every
 *  '<', matched or not) — so the "safe" fallback was reopening precisely the
 *  main-thread freeze the guard exists to prevent.
 *
 *  This scan is linear BY CONSTRUCTION rather than by claim: cursor `i` only
 *  ever moves forward, and every indexOf()/startsWith() lookahead begins where
 *  the previous one finished, so the ranges scanned across the whole call
 *  never overlap — total work is bounded by one pass over `html` regardless of
 *  content shape. Concretely, an unterminated tag or script/style block is
 *  handled by jumping straight to the end of the string ONCE, never retried
 *  character-by-character. Measured on the same 200,000-char adversarial
 *  input this replaces: see "does not freeze on 200,000 unterminated '<'
 *  characters" in tests/web-fetch-tool.test.ts for the pinned number. */
export function stripToText(html: string): string {
  const n = html.length;
  // One O(n) pass so script/style tag names and their closers can be located
  // case-insensitively via indexOf, instead of lowercasing a slice per tag.
  const lower = html.toLowerCase();
  const parts: string[] = [];
  let i = 0;
  let textStart = 0;
  while (i < n) {
    if (html.charCodeAt(i) !== 60 /* '<' */) { i++; continue; }
    if (i > textStart) parts.push(html.slice(textStart, i));
    if (lower.startsWith('<script', i) || lower.startsWith('<style', i)) {
      const closer = lower.startsWith('<script', i) ? '</script>' : '</style>';
      const closeIdx = lower.indexOf(closer, i);
      // Not found: treat the rest of the document as inside this block and
      // stop — do NOT retry the search from i+1, which is what made the old
      // regex quadratic on input shaped like this.
      i = closeIdx === -1 ? n : closeIdx + closer.length;
    } else {
      const gt = html.indexOf('>', i);
      // Unterminated tag: drop everything after it rather than re-scanning
      // for a '>' that will never arrive.
      i = gt === -1 ? n : gt + 1;
    }
    parts.push(' ');
    textStart = i;
  }
  if (n > textStart) parts.push(html.slice(textStart, n));
  return parts.join('')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Same script/style removal as stripToText's first phase, but keeps every
 *  other byte (including other markup) instead of collapsing it to text. Used
 *  only to build a comparable denominator for looksJsRendered's density check
 *  below — see that function's WHY comment. Uses the same monotonic-cursor
 *  technique as stripToText above, for the same reason: linear regardless of
 *  content shape. */
function withoutScriptAndStyle(html: string): string {
  const n = html.length;
  const lower = html.toLowerCase();
  const parts: string[] = [];
  let i = 0;
  let textStart = 0;
  while (i < n) {
    if (html.charCodeAt(i) !== 60 || !(lower.startsWith('<script', i) || lower.startsWith('<style', i))) { i++; continue; }
    if (i > textStart) parts.push(html.slice(textStart, i));
    const closer = lower.startsWith('<script', i) ? '</script>' : '</style>';
    const closeIdx = lower.indexOf(closer, i);
    i = closeIdx === -1 ? n : closeIdx + closer.length;
    textStart = i;
  }
  if (n > textStart) parts.push(html.slice(textStart, n));
  return parts.join('');
}

// Cap on how much raw HTML the guard-path fallback (below) will turn into
// plain text. WHY (Important finding, 2026-08-06 review): the fallback exists
// to give the model SOMETHING useful when structured extraction was refused,
// not to render an entire document up to the 5MB body cap as plain text — a
// multi-megabyte tag-soup page would otherwise return megabytes of largely
// unreadable text. This is independent of the CRITICAL fix above (stripToText
// is linear now, so this cap is about usefulness, not runtime safety) and does
// NOT change MAX_TAGS, MAX_DEPTH, or the 5MB body cap itself.
const FALLBACK_CHAR_CAP = 200_000;

/** stripToText, bounded to FALLBACK_CHAR_CAP raw characters, for the guard
 *  (too-complex) path only. The JS-render density check below needs the FULL
 *  text and calls stripToText directly. */
function stripToTextCapped(html: string): { text: string; truncated: boolean } {
  const capped = html.length > FALLBACK_CHAR_CAP;
  return { text: stripToText(capped ? html.slice(0, FALLBACK_CHAR_CAP) : html), truncated: capped };
}

// --- JS-rendered-page disclosure (task 12) ------------------------------------
// Diagnosed 2026-08-01: WebFetch returned a clean, well-under-cap extraction of
// vitest.dev/config/ and the model confidently reported the `include` option
// "is not documented" — the content simply never arrives in the server's HTML;
// it is fetched by client-side JS after the page loads. Extraction-coverage ratio
// CANNOT be the signal (measured 70.3% on this false-negative page vs 69.1% on a
// known-good server-rendered page — indistinguishable), so detection instead
// combines a framework marker with raw text density.

/** Markers of a client-rendered app shell. */
const JS_APP_MARKERS = /__VP_HASH_MAP__|__NEXT_DATA__|__NUXT__|__remixContext|__sveltekit|window\.__INITIAL_STATE__/;
const EMPTY_ROOT = /<div id="(?:root|app|__next)"\s*>\s*<\/div>/i;
/** Visible-text-to-bytes ratio below which a page is mostly scaffolding. The
 *  denominator excludes <script>/<style> bytes — see the WHY comment on
 *  looksJsRendered below for why that matters. Re-measured on the two
 *  committed fixtures after that fix (2026-08-06): vitest-config.html (the
 *  false-negative page from the 2026-08-01 incident) 7.18%; asyncio.html
 *  (server-rendered, near-identical extraction ratio before this fix) 19.07%.
 *  Both these are what the committed test fixtures actually measure, not the
 *  5.3%/16.0% an earlier draft of this comment claimed. 10% still sits in the
 *  gap between them. */
const TEXT_DENSITY_FLOOR = 0.10;

/** Core of the JS-render check, taking an already-computed stripped text so
 *  callers that need that text anyway (execute(), below) don't pay for a
 *  second stripToText() pass over the same html. */
function jsRenderDensity(html: string, strippedText: string): boolean {
  const hasMarker = JS_APP_MARKERS.test(html) || EMPTY_ROOT.test(html);
  if (!hasMarker) return false;
  const denominator = withoutScriptAndStyle(html).length;
  return strippedText.length / Math.max(denominator, 1) < TEXT_DENSITY_FLOOR;
}

/** True when the served HTML looks like an app shell whose content arrives via
 *  JavaScript. We CANNOT know what is missing — from the response's point of view
 *  nothing is — so callers must phrase the disclosure non-committally per
 *  docs/error-message-standards.md.
 *
 *  WHY the denominator excludes <script>/<style> bytes (Important finding,
 *  2026-08-06 review): stripToText already strips script/style bodies out of
 *  the NUMERATOR, but the denominator used to be the raw html.length, which
 *  still counted them — so a routine SSR hydration blob (e.g. Next.js'
 *  __NEXT_DATA__) deflated the ratio regardless of whether the visible prose
 *  was complete. A simulated SSR page with full article content plus a normal
 *  __NEXT_DATA__ blob measured 7.31% under the old (html.length) denominator —
 *  misfiring below the 10% floor on a page where nothing was missing — and
 *  89.29% under this one. See the "SSR page with a hydration blob" test. */
export function looksJsRendered(html: string): boolean {
  return jsRenderDensity(html, stripToText(html));
}

// --- URL fragment resolution (task 13) -----------------------------------------

// WHY this scans both `id=` (any tag) and `<a name=...>` (Important finding,
// 2026-08-06 review): the previous regex was /\sid="([^"]+)"/gi — double-quoted
// only. Single-quoted id='x', unquoted id=x, and legacy <a name="x"> anchors
// all missed silently; the committed vitest-config.html fixture alone carries
// 9 `name="` attributes that the old scan never saw. `resolveFragment`'s
// `absent` result is reported to the model as a categorical "this anchor does
// not exist" (see execute() below), so under-scanning here directly produced
// false claims.
const ID_ATTR_RE = /\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/gi;
const ANCHOR_NAME_RE = /<a\b[^>]*?\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/gi;

/** Every id= (any element, any quoting) and legacy <a name=...> anchor value
 *  in the document, case PRESERVED — case-sensitivity is resolved by the
 *  caller (resolveFragment), not here. */
function collectAnchorIds(rawHtml: string): Set<string> {
  const ids = new Set<string>();
  for (const re of [ID_ATTR_RE, ANCHOR_NAME_RE]) {
    for (const m of rawHtml.matchAll(re)) {
      const value = m[1] ?? m[2] ?? m[3];
      if (value) ids.add(value);
    }
  }
  return ids;
}

/** Locate a URL fragment's section in the extracted markdown.
 *
 *  WHY this exists at all: a #fragment is never sent to a server, so refetching
 *  with one returns identical bytes — correct HTTP that reads like a bug. The
 *  fixable part is resolving it AFTER extraction, which turns a silent false
 *  negative into an explicit statement.
 *
 *  WHY matching goes through anchor hrefs and not heading text: VitePress emits
 *  `## Config Options [​](#config-options)`, so slugifying the heading text yields
 *  "config-options-config-options" and misses. The `id="..."` attributes in the raw
 *  HTML are authoritative and independent of markdown rendering.
 *
 *  WHY id matching tries exact case first (Minor finding, 2026-08-06 review):
 *  HTML `id` is case-sensitive (`#Foo` and `id="foo"` are different anchors),
 *  but the old code lowercased both sides unconditionally, so a fragment could
 *  falsely resolve against a same-spelling-different-case id. The fallback
 *  case-insensitive match is kept (real pages do sometimes get linked with the
 *  "wrong" case and a hit is still useful) but the caller is told which kind
 *  of match it got so it can say so rather than imply an exact one.
 *
 *  `bodyTruncated` scopes the `absent` result's wording (Important finding):
 *  when the fetched body was cut off at the 5MB cap, "this anchor does not
 *  exist" is a claim about bytes that were never read, not about the page. */
export function resolveFragment(
  rawHtml: string,
  markdown: string,
  fragment: string,
  bodyTruncated = false,
):
  | { kind: 'found'; section: string; exactCase: boolean }
  | { kind: 'dropped'; exactCase: boolean }
  | { kind: 'absent'; bodyTruncated: boolean } {
  const ids = collectAnchorIds(rawHtml);
  let matched: string | null = null;
  let exactCase = true;
  if (ids.has(fragment)) {
    matched = fragment;
  } else {
    const lowerFragment = fragment.toLowerCase();
    for (const id of ids) {
      if (id.toLowerCase() === lowerFragment) { matched = id; exactCase = false; break; }
    }
  }
  if (matched === null) return { kind: 'absent', bodyTruncated };
  // Markdown heading/slug text is already case-normalized by the renderer
  // (VitePress etc. lowercase slugs regardless of source id case), so this
  // half of the match stays a lowercase comparison — only the raw-HTML id
  // lookup above needed the exact-case-first fix.
  const frag = fragment.toLowerCase();
  const lines = markdown.split('\n');
  const start = lines.findIndex(
    (l) => /^#{1,6} /.test(l) && (l.toLowerCase().includes(`(#${frag})`) || slugify(l) === frag),
  );
  if (start === -1) return { kind: 'dropped', exactCase };
  const level = (lines[start].match(/^#+/) ?? ['#'])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6}) /);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return { kind: 'found', section: lines.slice(start, end).join('\n').trim(), exactCase };
}

/** Heading text → slug, with any trailing anchor link removed first. */
function slugify(heading: string): string {
  return heading
    .replace(/^#+\s*/, '')
    .replace(/\[.*?\]\(#.*?\)\s*$/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function htmlToMarkdown(rawHtml: string): { title: string | null; markdown: string } {
  // linkedom's parsed document satisfies Readability's DOM contract at runtime,
  // but its typings don't match @mozilla/readability's `Document` param — cast
  // narrowly here rather than pull in a jsdom-shaped global Document type.
  const { document } = parseHTML(rawHtml);
  const article = new Readability(document as unknown as Document).parse();
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  if (article?.content) return { title: article.title ?? null, markdown: turndown.turndown(article.content) };
  // Readability found no article (a dashboard, an index page…) — fall back to the
  // whole body so the model still gets SOMETHING structured, never a silent empty.
  const body = document.body?.innerHTML ?? rawHtml;
  return { title: document.title || null, markdown: turndown.turndown(body) };
}

export const WebFetchTool = defineTool<z.infer<typeof inputSchema>>({
  name: 'WebFetch',
  description:
    'Fetch a web page and return its main content as Markdown. Only public http/https URLs — private and local addresses are blocked. Large pages are truncated.',
  // Compact form for small local models (simplified presentation).
  shortDescription: 'Fetch a public web page (http/https) and return its main content as Markdown.',
  inputSchema,
  permissionSubject: (args) => args.url,
  async execute(args, ctx) {
    let res: Response, finalUrl: string;
    try {
      ({ res, finalUrl } = await guardedFetch(args.url, { signal: ctx.signal, ...testHooks }));
    } catch (err) {
      if (err instanceof NetGuardError) return { text: `WebFetch blocked: ${err.message}`, isError: true };
      throw err; // defineTool's catch turns it into an actionable error result
    }
    if (!res.ok) {
      return { text: `WebFetch failed: ${finalUrl} answered HTTP ${res.status}${res.statusText ? ` (${res.statusText})` : ''}.`, isError: true };
    }
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    let isHtml = contentType.startsWith('text/html') || contentType.startsWith('application/xhtml');
    const isText = TEXT_TYPES.test(contentType);
    // A bare/misconfigured HTML server may omit content-type entirely. Don't refuse
    // outright: defer the decision until after we've read the body and can sniff it
    // (below). A NON-empty, non-html, non-text type IS a real binary — refuse now,
    // before downloading it.
    const noContentType = contentType.trim() === '';
    if (!isHtml && !isText && !noContentType) {
      return { text: `WebFetch can only read HTML and text content; ${finalUrl} is ${contentType || 'an unknown binary type'}.`, isError: true };
    }
    // CHARSET NOTE: readBodyCapped decodes as UTF-8 unconditionally (it lives in
    // net-guard.ts — not editable this round). A shift_jis / latin-1 page therefore
    // renders as mojibake. Accepted for a preview-grade extraction; a proper
    // charset-aware decode is deferred.
    const { text: raw, truncated } = await readBodyCapped(res, MAX_BODY_BYTES);
    // No content-type header: sniff the decoded body. Real HTML starts (after
    // optional whitespace/BOM) with a doctype or <html>. Anything else stays a
    // refusal — we couldn't determine it's readable text/html.
    if (noContentType) {
      if (/^\s*<(?:!doctype\s+html\b|html\b)/i.test(raw)) {
        isHtml = true;
      } else {
        return { text: `WebFetch can only read HTML and text content; ${finalUrl} is ${contentType || 'an unknown binary type'}.`, isError: true };
      }
    }
    const header = [
      args.prompt ? `Fetched for: ${args.prompt}` : null,
      `Source: ${finalUrl}`,
    ].filter(Boolean).join('\n');
    if (!isHtml) {
      return { text: `${header}\n\n${raw}${truncated ? '\n\n[body truncated at 5MB]' : ''}` };
    }
    // DoS guard: never run the synchronous ~quadratic Readability parse on
    // pathological HTML. But WHY this no longer hard-fails (2026-08-06): the guard
    // is specifically about Readability's cost, and tag-stripping is now genuinely
    // linear (see stripToText's WHY comment) and safe on any input — so we can
    // still return honest content. The old refusal left the model with nothing
    // and no way forward (2026-08-01 review, finding #1).
    const tooComplex = tooComplexToExtract(raw);
    if (tooComplex) {
      // WHY stripToTextCapped (not stripToText) here, and WHY the 5MB-truncation
      // notice is appended too (Important findings, 2026-08-06 review): this
      // branch previously called the unbounded stripToText and dropped the
      // "[body truncated at 5MB]" notice every other return path appends — so a
      // 7MB tag-heavy page silently returned 5MB of text with no sign 2MB were
      // discarded, inside the exact code path whose purpose is eliminating
      // silent truncation.
      const { text: fallbackText, truncated: fallbackCapped } = stripToTextCapped(raw);
      const capNote = fallbackCapped
        ? ` Showing only the first ${(FALLBACK_CHAR_CAP / 1000).toFixed(0)}KB of this page's raw HTML — the rest was not scanned.`
        : '';
      return {
        text: `${header}\n\n[This page is too large or deeply nested for structured extraction, so this is a simplified extraction: plain text with no headings, links, or code formatting.${capNote}]\n\n${fallbackText}${truncated ? '\n\n[body truncated at 5MB]' : ''}`,
      };
    }
    const { title, markdown } = htmlToMarkdown(raw);
    // Minor finding (2026-08-06 review): stripToText(raw) used to be recomputed
    // separately for the density check and for the KB figure in jsNote below —
    // compute it once here and pass it into both.
    const strippedRaw = stripToText(raw);
    // Honest, non-committal disclosure: state what was observed, never guess what
    // is absent. Without this a JS-rendered docs page returns a confident preamble
    // and the model reports "the docs do not document X" (2026-08-01 review).
    const jsNote = jsRenderDensity(raw, strippedRaw)
      ? `\n\n[This page is a JavaScript-rendered app. The server sent ${(strippedRaw.length / 1024).toFixed(1)} KB of text; content that loads in a browser is not included. If a section you expected is absent, it is likely rendered client-side.]`
      : '';
    // A fragment on the request URL is a question about ONE section. Answer it
    // directly, and be explicit when we cannot.
    let fragmentNote = '';
    let body = markdown;
    const hash = (() => { try { return new URL(finalUrl).hash.replace(/^#/, ''); } catch { return ''; } })();
    if (hash) {
      const f = resolveFragment(raw, markdown, hash, truncated);
      if (f.kind === 'found') {
        body = f.section;
        const caseNote = f.exactCase ? '' : ' (matched case-insensitively — the served id differs in case from the fragment)';
        fragmentNote = `\n\n[Showing the "#${hash}" section only${caseNote}. Refetch without the fragment for the whole page.]`;
      } else if (f.kind === 'dropped') {
        const caseNote = f.exactCase ? '' : ' (case-insensitive match)';
        fragmentNote = `\n\n[The page has an anchor named "#${hash}"${caseNote}, but article extraction did not keep that section. The full text above is what was extracted.]`;
      } else {
        // Important finding (2026-08-06 review): this used to be a flat "the
        // HTML contains no anchor named X" regardless of whether the body was
        // truncated at the 5MB cap — a categorical claim about bytes that, when
        // truncated, were never actually read. Scope the wording to what was
        // examined.
        fragmentNote = f.bodyTruncated
          ? `\n\n[No anchor named "#${hash}" was found in the portion of this page that was fetched. The body was truncated at 5MB, so a later part of the page may still contain it.]`
          : `\n\n[The HTML served for this URL contains no anchor named "#${hash}".]`;
      }
    }
    return { text: `${header}${title ? `\nTitle: ${title}` : ''}\n\n${body}${fragmentNote}${jsNote}${truncated ? '\n\n[body truncated at 5MB]' : ''}` };
  },
});
