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

/** Tag-strip to readable text. O(n) on the raw string, so it is safe on input
 *  that would hang Readability's ~quadratic parse. */
export function stripToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
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
/** Visible-text-to-bytes ratio below which a page is mostly scaffolding.
 *  Measured 2026-08-06: vitest.dev/config 5.3%; docs.python.org asyncio 16.0%;
 *  nodejs.org/api/fs 24.2%; example.com 25.4%. 10% sits in the gap. */
const TEXT_DENSITY_FLOOR = 0.10;

/** True when the served HTML looks like an app shell whose content arrives via
 *  JavaScript. We CANNOT know what is missing — from the response's point of view
 *  nothing is — so callers must phrase the disclosure non-committally per
 *  docs/error-message-standards.md. */
export function looksJsRendered(html: string): boolean {
  const hasMarker = JS_APP_MARKERS.test(html) || EMPTY_ROOT.test(html);
  if (!hasMarker) return false;
  const density = stripToText(html).length / Math.max(html.length, 1);
  return density < TEXT_DENSITY_FLOOR;
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
    // is specifically about Readability's cost, and tag-stripping is O(n) and safe
    // on any input — so we can still return honest content. The old refusal left
    // the model with nothing and no way forward (2026-08-01 review, finding #1).
    const tooComplex = tooComplexToExtract(raw);
    if (tooComplex) {
      return {
        text: `${header}\n\n[This page is too large or deeply nested for structured extraction, so this is a simplified extraction: plain text with no headings, links, or code formatting.]\n\n${stripToText(raw)}`,
      };
    }
    const { title, markdown } = htmlToMarkdown(raw);
    // Honest, non-committal disclosure: state what was observed, never guess what
    // is absent. Without this a JS-rendered docs page returns a confident preamble
    // and the model reports "the docs do not document X" (2026-08-01 review).
    const jsNote = looksJsRendered(raw)
      ? `\n\n[This page is a JavaScript-rendered app. The server sent ${(stripToText(raw).length / 1024).toFixed(1)} KB of text; content that loads in a browser is not included. If a section you expected is absent, it is likely rendered client-side.]`
      : '';
    return { text: `${header}${title ? `\nTitle: ${title}` : ''}\n\n${markdown}${jsNote}${truncated ? '\n\n[body truncated at 5MB]' : ''}` };
  },
});
