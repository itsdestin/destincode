// WebSearch (spec §3.2): thin over the injected SearchService — ONE stable tool
// interface regardless of which backend answered. Result is a markdown string
// (the WebSearchView + collapsed header read input.query / a text response).
import { z } from 'zod';
import { defineTool } from './registry';
import { SearchUnavailableError } from '../search/search-service';

const inputSchema = z.object({ query: z.string().min(1).describe('The search query') });

export const WebSearchTool = defineTool<z.infer<typeof inputSchema>>({
  name: 'WebSearch',
  description: 'Search the web. Returns titles, URLs, and snippets — use WebFetch to read a promising result in full. Use this whenever fresh or current information matters.',
  inputSchema,
  permissionSubject: (args) => args.query,
  async execute(args, ctx) {
    if (!ctx.services?.search) {
      return { text: 'Web search is not wired for this session; this is a configuration error.', isError: true };
    }
    try {
      const { results, source } = await ctx.services.search.search(args.query, ctx.signal);
      // Result fields are UNTRUSTED web content interpolated into a numbered
      // markdown list. Collapse internal whitespace/newlines so a title like
      // "\n\n2. **fake**" can't fabricate extra list items or inject
      // instruction-shaped lines into the model-facing text.
      const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
      const lines = results.slice(0, 8).map((r, i) =>
        `${i + 1}. **${clean(r.title)}**\n   ${clean(r.url)}${r.snippet ? `\n   ${clean(r.snippet)}` : ''}`);
      return { text: `Web search results for "${args.query}" (via ${source}):\n\n${lines.join('\n\n')}` };
    } catch (err: any) {
      if (err instanceof SearchUnavailableError) return { text: err.message, isError: true };
      throw err; // defineTool catch → actionable error / abort labeling
    }
  },
});
