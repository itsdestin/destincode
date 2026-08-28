import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { defineTool } from './registry';
import { canonicalize, resolveP } from './guards';
import { toHunks } from './edit';

export const WriteTool = defineTool({
  name: 'Write',
  // Mirrors Edit's description — same gate, so it must be described the same
  // way (2026-08-11 review round 8; see the WHY above EditTool.description).
  description:
    'Create a new file or fully overwrite an existing one. Overwriting requires that the file '
    + 'have been Read or Written by you in this session, and not have changed on disk since — '
    + 'those tools record the file\'s modification time, which is what detects a stale overwrite. '
    + 'Creating a file that does not exist yet needs no prior Read.',
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
      // D-4: mirrors Edit — the registry resets on resume, so name resume as a
      // cause or the model argues with a refusal its memory says is wrong.
      return {
        text: `Write rejected: ${args.file_path} already exists and you have not Read it in this session `
          + '(this also happens after a session resume — earlier reads are forgotten), '
          + 'so you would be replacing content you have not seen. Read it first (a cat/grep does not count '
          + '— the Read tool records the file\'s modification time, which is what detects a later change), '
          + 'then retry.',
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
        text: `Write rejected: ${args.file_path} changed on disk since you last Read or Wrote it `
          + '(its modification time no longer matches), so you would be overwriting changes you have '
          + 'not seen. Read it again, then retry.',
        isError: true,
      };
    }
    const old = exists ? fs.readFileSync(abs, 'utf8') : '';
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, args.content);
    ctx.readRegistry.set(canonical, fs.statSync(abs).mtimeMs);
    return {
      // Says out loud that this Write satisfied the read gate (2026-08-11 review
      // round 8). It always has — the registry line above is what does it — but
      // silently, so Qwen 3.6 35B Wrote a file, Edited it successfully, and
      // reported that "Edit doesn't enforce read-first." The registration is the
      // only part of the gate's state a model can be told about in-band.
      text: `${exists ? 'Overwrote' : 'Created'} ${args.file_path} (${args.content.length} chars). `
        + 'This counts as having Read it — you can Edit it now without reading it first.',
      structuredPatch: toHunks(old, args.content, args.file_path),
    };
  },
});
