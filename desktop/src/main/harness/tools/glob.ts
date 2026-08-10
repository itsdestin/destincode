// Dedicated tool, not shell (research R§3: small models butcher quoting).
// Recursive walk + subjectMatches-style file glob; mtime-sorted like CC's.
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { defineTool } from './registry';
import { resolveP } from './guards';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);
/** How many matches we RETURN. */
const RESULT_LIMIT = 2_000;
/** How many we are willing to hold in memory while walking. Far above any real
 *  query; purely a runaway guard. */
const WALK_CEILING = 50_000;

// Fix (flagged bug): single-pass converter. The multi-pass sketch clobbered its
// own output — the final `*`→`[^/]*` replace also rewrote the `*` inside the
// already-substituted `(?:.*/)?` / `.*` tokens, so `**/*.ts` matched NOTHING.
// Scanning once keeps each token intact.
//   '**/'  crosses separators and is optional (top-level match)   → (?:.*/)?
//   '**'   crosses separators                                     → .*
//   '*'    does not cross separators                              → [^/]*
//   '?'    single non-separator char                              → [^/]
//   '{a,b,c}' non-nested brace alternation                        → (?:a|b|c)
//
// Fix (2026-08-10 review, item 1 — braces): this converter used to ESCAPE '{'
// and '}' as literal regex characters, so `**/*.{ts,kt,toml}` compiled to a
// regex requiring the literal substring ".{ts,kt,toml}" in the path — no real
// file ever has that, so the tool returned "No files matched." with zero
// signal that the SYNTAX, not the search, was the problem. Two reviewing
// models hit this independently; Kimi K3 called it "the only result in the
// whole battery I'd call misleading." Claude Code supports braces because it
// shells out to ripgrep, whose globset engine handles them natively — we stay
// on this hand-rolled converter (rewriting Glob to shell to ripgrep would also
// mean re-deriving mtime sort, WALK_CEILING, cancellation, and the external-
// root path rebasing around a child process, none of which brace support
// needs) and instead expand `{a,b,c}` into a regex alternation ourselves,
// non-nested only — the same restriction ripgrep's own globset enforced
// pre-15.0.0, so a plain extension list (the reported bug shape) is fully
// supported and a nested construct fails the same loud, honest "No files
// matched." it always did, rather than silently mismatching. See
// docs/active/investigations/2026-08-10-harness-search-tools-prior-art.md item 1.
function fileGlobToRegex(glob: string): RegExp {
  let rx = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++; // consume second '*'
        if (glob[i + 1] === '/') {
          i++; // consume '/'
          rx += '(?:.*/)?';
        } else {
          rx += '.*';
        }
      } else {
        rx += '[^/]*';
      }
    } else if (c === '?') {
      rx += '[^/]';
    } else if (c === '{') {
      const close = glob.indexOf('}', i + 1);
      const inner = close === -1 ? '' : glob.slice(i + 1, close);
      if (close !== -1 && !inner.includes('{')) {
        // Recurse per alternative through this SAME converter so an
        // alternative can itself contain '*'/'?' (e.g. "{a*.ts,b.kt}"), then
        // strip the '^'/'$' anchors the recursive call adds before splicing
        // into the surrounding alternation group.
        const alts = inner.split(',').map((part) => fileGlobToRegex(part).source.slice(1, -1));
        rx += `(?:${alts.join('|')})`;
        i = close;
      } else {
        // No matching '}', or a nested '{' inside (unsupported — matches
        // ripgrep's own restriction): fall through to the prior literal-
        // escape behavior rather than guessing at a meaning.
        rx += '\\{';
      }
    } else if ('.+^${}()|[]\\'.includes(c)) {
      rx += '\\' + c;
    } else {
      rx += c;
    }
  }
  return new RegExp(`^${rx}$`, 'i');
}

export const GlobTool = defineTool({
  name: 'Glob',
  description: 'Find files by glob pattern (e.g. "src/**/*.ts"). Returns paths sorted by modification time, newest first.',
  // Compact form for small local models (simplified presentation, spec §4.2).
  shortDescription: 'Find files matching a glob pattern, newest first.',
  // Fix (2026-08-10 review, item 5): neither parameter had a `.describe()` at
  // all, which let a model infer meaning (or a difference from Grep's `path`)
  // it wasn't told. `path` uses the SAME wording as Grep's — verification
  // showed they mean the identical thing (the search-root directory) in both
  // tools' code; DeepSeek's "Grep's path is a directory but Glob's is a base"
  // claim was refuted, and the fix for a model inferring a non-existent
  // distinction is documenting both, identically, not renaming either.
  inputSchema: z.object({
    pattern: z
      .string()
      .describe('Glob pattern to match file paths against, e.g. "src/**/*.ts" or "**/*.{ts,tsx}". Supports *, **, ?, and non-nested {a,b,c} alternation.'),
    path: z.string().optional().describe('The directory to search in (relative to the working directory). Defaults to the current directory.'),
  }),
  // Bounds are now explicit here rather than borrowed from DEFAULT_CAPS, since
  // Glob's own cap (RESULT_LIMIT, above) is what actually decides how much text
  // comes back — the pipeline's char cap should not silently apply a different
  // number to the same field.
  caps: { maxChars: 30_000 },
  // Static fallback for composeNotice's no-bounds branch (Task 19): a result
  // list can sit under WALK_CEILING/RESULT_LIMIT (so `bounds` stays undefined —
  // nothing was withheld at the FILE-COUNT level) while still exceeding
  // `maxChars` on sheer path length (e.g. 2,000 long paths). Verbatim copy of
  // the `bounds.moreHint` string below.
  moreHint: 'narrow the glob pattern or pass a more specific path',
  permissionSubject: (a) => a.path ?? '.',
  async execute(args, ctx) {
    const root = resolveP(args.path ?? '.', ctx.cwd);
    const rx = fileGlobToRegex(args.pattern);
    const hits: Array<{ rel: string; mtime: number }> = [];
    let ceilingHit = false;
    // Fix (Important 4, 2026-08-06 review): the walk used to return silently on
    // `ctx.signal.aborted` with nothing recording that it stopped early, so a
    // cancelled search that had gathered fewer than RESULT_LIMIT hits declared
    // no `bounds` and handed back a partial list as if it were the complete
    // answer. Track it explicitly and short-circuit with the same cancellation
    // shape Grep already uses (grep.ts) — one convention for "the user hit
    // interrupt mid-search", not a second one invented here.
    let interrupted = false;
    const walk = (dir: string, rel: string) => {
      if (ctx.signal.aborted) { interrupted = true; return; }
      if (hits.length >= WALK_CEILING) { ceilingHit = true; return; }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        // Fix (Minor 5, 2026-08-06 review): this check used to run only once
        // per walk() CALL (i.e. once per directory), so one directory holding
        // 500k matching files pushed every single one onto `hits` before the
        // NEXT recursive call ever re-checked the ceiling — the comment called
        // WALK_CEILING a "runaway guard" but the code didn't bound a single
        // directory's contribution. Checking inside the entry loop makes the
        // code match the comment.
        if (hits.length >= WALK_CEILING) { ceilingHit = true; break; }
        if (ctx.signal.aborted) { interrupted = true; break; }
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
          continue;
        }
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (rx.test(r)) {
          try {
            hits.push({ rel: r, mtime: fs.statSync(path.join(dir, e.name)).mtimeMs });
          } catch {
            /* raced delete */
          }
        }
      }
    };
    walk(root, '');
    if (interrupted) {
      return { text: 'Canceled: the user interrupted this search.', isError: true };
    }
    // WHY the walk now completes before the cap is applied (2026-08-06): it used
    // to abort at 2,000 hits BEFORE this sort, so a capped result was an arbitrary
    // 2,000 files in directory order — while the tool description promised
    // "sorted by modification time, newest first". That promise was false on any
    // large tree, and nothing in the output said the list was partial.
    hits.sort((a, b) => b.mtime - a.mtime);
    const shown = hits.slice(0, RESULT_LIMIT);
    // Paths are relative to the SEARCH ROOT above; re-base onto the workspace root
    // so Glob and Grep return the same shape for the same file.
    const base = path.relative(ctx.cwd, root);
    const rebase = (r: string) => {
      if (!base) return r; // search root IS the workspace root — already bare-relative.
      // Fix (Important 3, 2026-08-06 review): when `root` is outside the
      // workspace (an approved external directory), path.relative returns a
      // `..`-prefixed string (or, cross-drive on Windows, an absolute path
      // outright) — the old code fell through its `!base.startsWith('..')`
      // check and returned the search-root-relative string UNCHANGED, so Glob
      // printed "src/a.ts" for a file that lives at /tmp/ext-X/src/a.ts. Grep
      // already returns the absolute path for this exact case (grep.ts
      // `searchTarget`); match it so the model doesn't read an external file as
      // a workspace one.
      if (base.startsWith('..') || path.isAbsolute(base)) return path.join(root, r);
      // Fix (Minor 6, 2026-08-06 review): `base` comes from path.relative and
      // uses the OS separator ('\' on Windows); `r` is built by walk() with a
      // hardcoded '/'. Concatenating them unnormalized produced mixed paths
      // like "src\sub/a.ts" on Windows. Normalize base to '/' so the whole
      // returned path uses one separator.
      return `${base.split(path.sep).join('/')}/${r}`;
    };
    return {
      text: shown.length ? shown.map((h) => rebase(h.rel)).join('\n') : 'No files matched.',
      bounds: hits.length > shown.length
        ? {
            shown: shown.length,
            // A ceiling hit means we stopped counting, so the total is unknown —
            // report it as unknown rather than as the number we happened to reach.
            total: ceilingHit ? null : hits.length,
            unit: 'files' as const,
            moreHint: 'narrow the glob pattern or pass a more specific path',
          }
        : undefined,
    };
  },
});
