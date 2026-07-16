// Dedicated tool, not shell (research R§3: small models butcher quoting).
// Recursive walk + subjectMatches-style file glob; mtime-sorted like CC's.
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { defineTool } from './registry';
import { resolveP } from './guards';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);

// Fix (flagged bug): single-pass converter. The multi-pass sketch clobbered its
// own output — the final `*`→`[^/]*` replace also rewrote the `*` inside the
// already-substituted `(?:.*/)?` / `.*` tokens, so `**/*.ts` matched NOTHING.
// Scanning once keeps each token intact.
//   '**/'  crosses separators and is optional (top-level match)   → (?:.*/)?
//   '**'   crosses separators                                     → .*
//   '*'    does not cross separators                              → [^/]*
//   '?'    single non-separator char                              → [^/]
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
  inputSchema: z.object({ pattern: z.string(), path: z.string().optional() }),
  permissionSubject: (a) => a.path ?? '.',
  async execute(args, ctx) {
    const root = resolveP(args.path ?? '.', ctx.cwd);
    const rx = fileGlobToRegex(args.pattern);
    const hits: Array<{ rel: string; mtime: number }> = [];
    const walk = (dir: string, rel: string) => {
      if (ctx.signal.aborted || hits.length >= 2000) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
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
    hits.sort((a, b) => b.mtime - a.mtime);
    return { text: hits.length ? hits.map((h) => h.rel).join('\n') : 'No files matched.' };
  },
});
