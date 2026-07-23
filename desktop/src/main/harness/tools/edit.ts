import * as fs from 'fs';
import { z } from 'zod';
import { structuredPatch } from 'diff';
import { defineTool } from './registry';
import { canonicalize, resolveP } from './guards';
import type { StructuredPatchHunk } from '../../../shared/types';

/** jsdiff → the reducer's StructuredPatchHunk shape (same fields; keep explicit). */
export function toHunks(oldText: string, newText: string, filePath: string): StructuredPatchHunk[] {
  return structuredPatch(filePath, filePath, oldText, newText).hunks.map((h) => ({
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines,
  }));
}

/** Detect and preserve line endings + BOM (Windows repos — spec §2.3). */
function preserveFormat(original: string, edited: string): string {
  const hasBom = original.charCodeAt(0) === 0xfeff;
  const crlf = original.includes('\r\n');
  let out = edited;
  // A CRLF file stays UNIFORMLY CRLF regardless of what the model puts in
  // new_string. We normalize any \r\n back to \n first, then expand every \n —
  // so a new_string that itself contains \r\n (or one that's pure \n) both land
  // as clean CRLF. The old `!out.includes('\r\n')` guard skipped re-expansion
  // whenever new_string carried even one \r\n, leaving the unchanged lines as LF
  // (a mixed, corrupted file). Matching already happens in LF space (see execute).
  if (crlf) out = out.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  if (hasBom && out.charCodeAt(0) !== 0xfeff) out = '﻿' + out;
  return out;
}

export const EditTool = defineTool({
  name: 'Edit',
  description:
    'Replace an exact string in a file. old_string must match exactly once (or pass replace_all). You must Read the file first.',
  inputSchema: z.object({
    file_path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }),
  permissionSubject: (a) => a.file_path,
  async execute(args, ctx) {
    const abs = resolveP(args.file_path, ctx.cwd);
    const canonical = canonicalize(args.file_path, ctx.cwd);
    // Read-before-edit gate (spec §2.3): the single rule that prevents blind overwrites.
    const readMtime = ctx.readRegistry.get(canonical);
    if (readMtime === undefined) {
      return { text: `Edit rejected: read ${args.file_path} with the Read tool first, then retry.`, isError: true };
    }
    if (fs.statSync(abs).mtimeMs !== readMtime) {
      return {
        text: `Edit rejected: ${args.file_path} changed since you read it. Read it again, then retry.`,
        isError: true,
      };
    }
    const original = fs.readFileSync(abs, 'utf8');
    // Strip a BOM for matching so old_string anchors don't mysteriously miss at byte 0.
    const body = original.charCodeAt(0) === 0xfeff ? original.slice(1) : original;
    // Fix (CRLF defect): match in LF space. Read output shows LF only — the model
    // literally cannot see (and so cannot reproduce) the invisible \r in a CRLF
    // file, so a multi-line old_string with \n would ALWAYS miss a \r\n file and
    // fail "old_string not found". We normalize the body to LF for matching +
    // replacement (old_string/new_string stay literal); preserveFormat(original,…)
    // then re-expands the all-LF result back to the file's real endings and
    // restores the BOM. Caveat: a MIXED-endings file that still contains a \r\n
    // after editing skips re-expansion (preserveFormat's `!out.includes('\r\n')`
    // guard), leaving the edited region LF — acceptable, mixed files are already broken.
    const lfBody = body.replace(/\r\n/g, '\n');
    const count = lfBody.split(args.old_string).length - 1;
    if (count === 0)
      return {
        text: 'Edit failed: old_string not found. Re-Read the file and copy the exact text, including whitespace.',
        isError: true,
      };
    if (count > 1 && !args.replace_all) {
      return {
        text: `Edit failed: old_string matches ${count} times. Add surrounding context to make it unique, or pass replace_all: true.`,
        isError: true,
      };
    }
    // Fix (flagged bug): split/join for replace_all AND a REPLACER FUNCTION for the
    // single-replace path — String.prototype.replace treats `$&`/`$1`/`$$` in the
    // replacement string as special patterns, which would corrupt new_string. A
    // function replacer (and split/join) inserts new_string literally.
    const edited = args.replace_all
      ? lfBody.split(args.old_string).join(args.new_string)
      : lfBody.replace(args.old_string, () => args.new_string);
    const final = preserveFormat(original, edited);
    fs.writeFileSync(abs, final);
    ctx.readRegistry.set(canonical, fs.statSync(abs).mtimeMs); // our own write stays "read"
    // Diff the LF pair so hunks show only the real change, not a whole-file \r\n churn.
    return { text: `Edited ${args.file_path}.`, structuredPatch: toHunks(lfBody, edited, args.file_path) };
  },
});
