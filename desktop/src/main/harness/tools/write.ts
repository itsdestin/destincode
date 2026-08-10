import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { defineTool } from './registry';
import { canonicalize, resolveP } from './guards';
import { toHunks } from './edit';

export const WriteTool = defineTool({
  name: 'Write',
  description: 'Create a new file or fully overwrite an existing one. To overwrite, you must Read the file first.',
  // Compact form for small local models (simplified presentation, spec §4.2).
  shortDescription: 'Create a new file or completely overwrite an existing one with new content.',
  inputSchema: z.object({ file_path: z.string(), content: z.string() }),
  permissionSubject: (a) => a.file_path,
  async execute(args, ctx) {
    const abs = resolveP(args.file_path, ctx.cwd);
    const canonical = canonicalize(args.file_path, ctx.cwd);
    const exists = fs.existsSync(abs);
    const readMtime = ctx.readRegistry.get(canonical);
    if (exists && readMtime === undefined) {
      return {
        text: `Write rejected: ${args.file_path} already exists. Read it first so you know what you are replacing.`,
        isError: true,
      };
    }
    // WHY (2026-08-10 review, Claim 2 -- THE HEADLINE ITEM): Write's guard used
    // to check only registry PRESENCE ("was this path ever Read this session"),
    // never freshness -- so a read from arbitrarily long ago still satisfied it
    // even if the file changed on disk in the interim. Opus 5's transcript
    // demonstrated it concretely: it Read config/settings.toml at tool-call 11,
    // then Wrote over the whole file at tool-call 38 -- 27 calls later, with no
    // intervening touch tracked -- and got no complaint. Edit already guards
    // this exact gap with an mtime comparison (below); mirroring it here (rather
    // than inventing a second mechanism) keeps Write and Edit internally
    // consistent, since both tools share the same "read it first" contract.
    // A content hash (SHA-256, as Gemini CLI's Edit does; raw byte comparison,
    // as OpenCode V2's writeIfUnchanged does) is genuinely more robust than
    // mtime -- a `touch`/checkout can bump mtime with unchanged bytes (a false
    // positive mtime would wrongly reject) and some filesystems' clock
    // resolution can miss a true same-second change (a false negative mtime
    // would wrongly allow) -- see
    // docs/active/investigations/2026-08-10-harness-mutation-safety-prior-art.md
    // item 1. That's a deliberately DEFERRED improvement: it should replace
    // mtime in BOTH Write and Edit together, not one tool at a time, or we'd
    // trade one guard inconsistency for a subtler one.
    if (exists && fs.statSync(abs).mtimeMs !== readMtime) {
      return {
        text: `Write rejected: ${args.file_path} changed since you read it. Read it again, then retry.`,
        isError: true,
      };
    }
    const old = exists ? fs.readFileSync(abs, 'utf8') : '';
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, args.content);
    ctx.readRegistry.set(canonical, fs.statSync(abs).mtimeMs);
    return {
      text: `${exists ? 'Overwrote' : 'Created'} ${args.file_path} (${args.content.length} chars).`,
      structuredPatch: toHunks(old, args.content, args.file_path),
    };
  },
});
