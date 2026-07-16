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
    const isHtml = contentType.startsWith('text/html') || contentType.startsWith('application/xhtml');
    if (!isHtml && !TEXT_TYPES.test(contentType)) {
      return { text: `WebFetch can only read HTML and text content; ${finalUrl} is ${contentType || 'an unknown binary type'}.`, isError: true };
    }
    const { text: raw, truncated } = await readBodyCapped(res, MAX_BODY_BYTES);
    const header = [
      args.prompt ? `Fetched for: ${args.prompt}` : null,
      `Source: ${finalUrl}`,
    ].filter(Boolean).join('\n');
    if (!isHtml) {
      return { text: `${header}\n\n${raw}${truncated ? '\n\n[body truncated at 5MB]' : ''}` };
    }
    const { title, markdown } = htmlToMarkdown(raw);
    return { text: `${header}${title ? `\nTitle: ${title}` : ''}\n\n${markdown}${truncated ? '\n\n[body truncated at 5MB]' : ''}` };
  },
});
