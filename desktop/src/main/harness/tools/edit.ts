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
export function preserveFormat(original: string, edited: string): string {
  const hasBom = original.charCodeAt(0) === 0xfeff;
  const crlf = original.includes('\r\n');
  let out = edited;
  if (crlf && !out.includes('\r\n')) out = out.replace(/\n/g, '\r\n');
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
    const count = body.split(args.old_string).length - 1;
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
      ? body.split(args.old_string).join(args.new_string)
      : body.replace(args.old_string, () => args.new_string);
    const final = preserveFormat(original, edited);
    fs.writeFileSync(abs, final);
    ctx.readRegistry.set(canonical, fs.statSync(abs).mtimeMs); // our own write stays "read"
    return { text: `Edited ${args.file_path}.`, structuredPatch: toHunks(body, edited, args.file_path) };
  },
});
