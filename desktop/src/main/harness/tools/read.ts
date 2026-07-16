import * as fs from 'fs';
import { z } from 'zod';
import { defineTool } from './registry';
import { canonicalize, resolveP } from './guards';

const BINARY_SNIFF_BYTES = 8000;

// Read runs in the Electron MAIN process, so an unbounded readFileSync is a
// whole-app blast radius: a model reading a multi-hundred-MB log OOMs the app,
// and anything >2 GB throws a raw RangeError from Buffer. Refuse before the read
// (statSync is cheap) with a cap well above any legit source file.
export const MAX_READ_BYTES = 50 * 1024 * 1024; // 50 MB

/** Refusal text if the file is too big to read whole, else null. Exported so the
 *  refusal branch is unit-testable without writing a 50 MB fixture. */
export function readSizeError(sizeBytes: number, filePath: string): string | null {
  if (sizeBytes <= MAX_READ_BYTES) return null;
  const mb = (sizeBytes / (1024 * 1024)).toFixed(0);
  // Honest hint: offset/limit can't help once we refuse the read entirely, so
  // point at tools that stream instead of loading the whole file into memory.
  return `Cannot read ${filePath}: file is ${mb} MB (limit 50 MB). Use Grep to search it, or Bash head/tail to sample it.`;
}

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
    const st = fs.statSync(abs);
    const sizeErr = readSizeError(st.size, args.file_path);
    if (sizeErr) return { text: sizeErr, isError: true };
    const buf = fs.readFileSync(abs);
    if (looksBinary(buf)) return { text: `Cannot read ${args.file_path}: it is a binary file.`, isError: true };
    const raw = buf.toString('utf8');
    const all = raw.split('\n');
    // A trailing newline yields a phantom empty final element ("a\nb\n" → 3, not
    // 4) — drop it so line counts and the paging trailer are honest.
    if (raw.endsWith('\n')) all.pop();
    const totalLines = all.length;
    const offset = args.offset ?? 1;
    const limit = Math.min(args.limit ?? 2000, 2000);
    // Record for the read-before-edit gate (mtime so a later external change
    // invalidates it) — the file exists and was readable, so it counts as read
    // even if the requested page is past EOF.
    ctx.readRegistry.set(canonicalize(args.file_path, ctx.cwd), st.mtimeMs);
    if (offset > totalLines) {
      return { text: `Read ${args.file_path}: offset ${offset} is past the end of the file (${totalLines} lines).`, isError: true };
    }
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
    const trailer =
      offset - 1 + limit < totalLines
        ? `\n[showing lines ${offset}-${offset + slice.length - 1} of ${totalLines} — use offset=${offset + limit} to continue]`
        : '';
    return { text: numbered + trailer };
  },
});
