import * as fs from 'fs';
import { z } from 'zod';
import { defineTool } from './registry';
import { canonicalize, resolveP, shellCwdMissHint } from './guards';

const BINARY_SNIFF_BYTES = 8000;

// Read runs in the Electron MAIN process, so an unbounded readFileSync is a
// whole-app blast radius: a model reading a multi-hundred-MB log OOMs the app,
// and anything >2 GB throws a raw RangeError from Buffer. Refuse before the read
// (statSync is cheap) with a cap well above any legit source file.
export const MAX_READ_BYTES = 50 * 1024 * 1024; // 50 MB

// WHY (2026-08-10 review, Claim 10): Read's isError returns used to speak THREE
// unreconciled dialects -- "Read failed: ..." (thrown exceptions, via
// registry.ts's generic catch-all), "Cannot read ...: ..." (this size refusal
// and the binary refusal below), and a bare "Read <path>: offset N is past the
// end..." (past-EOF -- no "failed"/"Cannot" prefix at all). Opus flagged the
// last one specifically: the prefix is "otherwise a reliable signal for 'did
// this succeed'". Unified into the SAME two prefixes the house style already
// uses elsewhere (Edit: "rejected" for a guard declining to act at all,
// "failed" for a bad request against an otherwise-permitted action): "Read
// rejected: ..." for refusals where we won't read this file at all (too big,
// binary), matching the thrown-exception path's "Read failed: ..." prefix
// family for the past-EOF case below, which is a bad request (invalid offset)
// against a file we DID agree to read.

/** Refusal text if the file is too big to read whole, else null. Exported so the
 *  refusal branch is unit-testable without writing a 50 MB fixture. */
export function readSizeError(sizeBytes: number, filePath: string): string | null {
  if (sizeBytes <= MAX_READ_BYTES) return null;
  const mb = (sizeBytes / (1024 * 1024)).toFixed(0);
  // Honest hint: offset/limit can't help once we refuse the read entirely, so
  // point at tools that stream instead of loading the whole file into memory.
  return `Read rejected: ${filePath}: file is ${mb} MB (limit 50 MB). Use Grep to search it, or Bash head/tail to sample it.`;
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
  // Compact form for small local models (simplified presentation, spec §4.2).
  shortDescription: "Read a file's contents by path, with optional line offset/limit.",
  inputSchema: z.object({
    file_path: z.string().describe('Absolute or workspace-relative path'),
    offset: z.number().int().min(1).optional().describe('1-based first line to read'),
    limit: z.number().int().min(1).optional().describe('Max lines to return'),
  }),
  caps: { maxChars: 100_000 },
  // Static fallback for composeNotice's no-bounds branch (Task 19): `bounds`
  // below is only set when the requested slice stops before EOF (`more`).
  // A full-length read (offset 1, default limit, file exactly 2000 lines) sets
  // `more: false` — but MAX_LINE (2000 chars/line) means the numbered text can
  // still be ~4M chars, well past `caps.maxChars`, with no bound declared.
  // NOT verbatim from `bounds.moreHint` below: that string interpolates the
  // NEXT offset (`use offset=${offset + limit}...`), a per-call number this
  // static property can't carry. Same vocabulary (offset/limit), generalized.
  moreHint: 'use offset and limit to read a smaller slice of the file',
  permissionSubject: (a) => a.file_path,
  async execute(args, ctx) {
    const abs = resolveP(args.file_path, ctx.cwd);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch (err: any) {
      // Fix (two independent 2026-08 harness reviews, Grok 4.5 + Qwen 3.8 Max —
      // see guards.ts's WHY block above shellCwdMissHint): Read always resolves
      // a relative path from the workspace root, but the model may have just
      // `cd`-moved Bash's cwd and assumed Read followed it. Before letting the
      // raw ENOENT stand alone, check whether the SAME path exists relative to
      // the shell's actual persisted cwd — only ever named when confirmed on
      // disk. Any other stat failure (permission, etc.) is unrelated to this
      // asymmetry and falls through unchanged to defineTool's generic catch.
      if (err?.code === 'ENOENT') {
        const hint = shellCwdMissHint(args.file_path, ctx, (p) => {
          try {
            return fs.statSync(p).isFile();
          } catch {
            return false;
          }
        });
        return { text: `Read failed: ${err.message}${hint}`, isError: true };
      }
      throw err;
    }
    const sizeErr = readSizeError(st.size, args.file_path);
    if (sizeErr) return { text: sizeErr, isError: true };
    const buf = fs.readFileSync(abs);
    if (looksBinary(buf)) return { text: `Read rejected: ${args.file_path}: it is a binary file.`, isError: true };
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
      return { text: `Read failed: ${args.file_path}: offset ${offset} is past the end of the file (${totalLines} lines).`, isError: true };
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
    // WHY a declared bound instead of the hand-written trailer this used to carry:
    // every tool now reports paging the same way, and the "use offset=N" advice is
    // Read's own vocabulary rather than a shared string other tools inherited.
    const more = offset - 1 + limit < totalLines;
    return {
      text: numbered,
      bounds: more
        ? { shown: slice.length, total: totalLines, unit: 'lines' as const, moreHint: `use offset=${offset + limit} to continue` }
        : undefined,
    };
  },
});
