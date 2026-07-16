import * as fs from 'fs';
import { z } from 'zod';
import { defineTool } from './registry';
import { canonicalize, resolveP } from './guards';

const BINARY_SNIFF_BYTES = 8000;

// A NUL byte in the first 8 KB is our binary heuristic — matches CC's refusal.
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export const ReadTool = defineTool({
  name: 'Read',
  description:
    'Read a file from the filesystem. Returns numbered lines. Use offset and limit for large files — output is capped at 2000 lines.',
  inputSchema: z.object({
    file_path: z.string().describe('Absolute or workspace-relative path'),
    offset: z.number().int().min(1).optional().describe('1-based first line to read'),
    limit: z.number().int().min(1).optional().describe('Max lines to return'),
  }),
  caps: { maxChars: 100_000 },
  permissionSubject: (a) => a.file_path,
  async execute(args, ctx) {
    const abs = resolveP(args.file_path, ctx.cwd);
    const buf = fs.readFileSync(abs);
    if (looksBinary(buf)) return { text: `Cannot read ${args.file_path}: it is a binary file.`, isError: true };
    const all = buf.toString('utf8').split('\n');
    const offset = args.offset ?? 1;
    const limit = Math.min(args.limit ?? 2000, 2000);
    const slice = all.slice(offset - 1, offset - 1 + limit);
    const MAX_LINE = 2000;
    const numbered = slice
      .map(
        (l, i) =>
          `${String(offset + i).padStart(6)}\t${
            l.length > MAX_LINE ? l.slice(0, MAX_LINE) + '…[line truncated]' : l
          }`,
      )
      .join('\n');
    // Record for the read-before-edit gate (mtime so a later external change invalidates it).
    ctx.readRegistry.set(canonicalize(args.file_path, ctx.cwd), fs.statSync(abs).mtimeMs);
    const trailer =
      offset - 1 + limit < all.length
        ? `\n[showing lines ${offset}-${offset + slice.length - 1} of ${all.length} — use offset=${offset + limit} to continue]`
        : '';
    return { text: numbered + trailer };
  },
});
