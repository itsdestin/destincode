// Bundled ripgrep (@vscode/ripgrep) — deterministic cross-platform search.
import { spawn } from 'child_process';
import { rgPath as bundledRgPath } from '@vscode/ripgrep';
import * as fs from 'fs';
import { z } from 'zod';
import { defineTool } from './registry';
import { resolveP } from './guards';

/** Resolve the ripgrep binary the tool will actually spawn.
 *
 * WHY (the real `spawn ENOTDIR` root cause, 2026-07-20): in the packaged app,
 * `@vscode/ripgrep` resolves `rgPath` via `createRequire(...).resolve()` to a
 * path INSIDE `app.asar` — e.g.
 *   /opt/YouCoded/resources/app.asar/node_modules/@vscode/ripgrep-linux-x64/bin/rg
 * `app.asar` is a FILE, not a directory, so that path's prefix component is not
 * a directory. `spawn()` therefore throws `spawn ENOTDIR` SYNCHRONOUSLY (before
 * any 'error' handler can attach), which is why every Grep failed in the
 * packaged app even after the earlier `cwd:` fix. electron-builder DOES unpack
 * the binary to `app.asar.unpacked/` (it auto-unpacks executables), but nothing
 * rewrote rgPath to point there. Mirror the pty-worker fix (session-manager.ts):
 * prefer the unpacked sibling when it exists, else fall back to the bundled
 * path (correct in dev, where there is no asar). Pure + exported for tests. */
export function resolveRgPath(raw: string = bundledRgPath): string {
  const unpacked = raw.replace(/app\.asar(?!\.unpacked)([/\\])/, `app.asar.unpacked$1`);
  if (unpacked !== raw && fs.existsSync(unpacked)) return unpacked;
  return raw;
}

/** Build the failure message from what ripgrep ACTUALLY said.
 *
 *  WHY (2026-08-01 review): the old code appended "Check the regex syntax." to
 *  every exit-2, including a missing-path IO error. A reviewing model got
 *  "No such file or directory ... Check the regex syntax." for a perfectly valid
 *  regex and a mistyped path. Per docs/error-message-standards.md an error is
 *  either specific and accurate or general and non-committal — never a guessed
 *  cause bolted onto a real one. */
export function grepErrorMessage(stderr: string, resolvedPath: string, cwd: string): string {
  const raw = stderr.trim() || 'ripgrep error';
  if (/regex parse error|error: (unclosed|repetition|unrecognized)/i.test(stderr)) {
    return `Grep failed: ${raw}. Check the regex syntax.`;
  }
  if (/No such file or directory|IO error for operation/i.test(stderr)) {
    return `Grep failed: ${resolvedPath} does not exist. Paths resolve from the workspace root (${cwd}); pass a path relative to it, or omit \`path\` to search the whole workspace.`;
  }
  return `Grep failed: ${raw}`;
}

export const GrepTool = defineTool({
  name: 'Grep',
  description:
    'Search file contents with a regex (ripgrep). output_mode: "content" (matching lines), "files_with_matches" (default), or "count".',
  // Compact form for small local models (simplified presentation, spec §4.2).
  shortDescription: 'Search file contents with a regular expression.',
  inputSchema: z.object({
    pattern: z.string(),
    path: z.string().optional(),
    glob: z.string().optional().describe('Filter files, e.g. "*.ts"'),
    output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
  }),
  caps: { maxChars: 30_000, maxLines: 250 },
  permissionSubject: (a) => a.path ?? '.',
  async execute(args, ctx) {
    const mode = args.output_mode ?? 'files_with_matches';
    const rgArgs = ['--no-config', '--hidden', '--glob', '!.git', '--max-count', '500'];
    if (mode === 'files_with_matches') rgArgs.push('-l');
    if (mode === 'count') rgArgs.push('--count');
    if (mode === 'content') rgArgs.push('-n');
    if (args.glob) rgArgs.push('--glob', args.glob);
    // Hoisted so the exit-2 error message (below) can name the exact path that
    // failed, instead of a context-free "ripgrep error".
    const resolvedTarget = resolveP(args.path ?? '.', ctx.cwd);
    rgArgs.push('--', args.pattern, resolvedTarget);
    return new Promise((resolve) => {
      // Two spawn defenses, both learned from `spawn ENOTDIR` (2026-07-20):
      //  1. `cwd: ctx.cwd` explicitly — never inherit the Electron main process's
      //     ambient cwd (the original PR #172 fix; still correct).
      //  2. `resolveRgPath()` — rewrite an inside-asar rgPath to the unpacked
      //     binary (the ACTUAL root cause; see resolveRgPath above).
      const rgBin = resolveRgPath();
      // spawn() throws SYNCHRONOUSLY when the command path or cwd has a
      // non-directory prefix (e.g. an inside-asar binary path). That throw happens
      // before the 'error' handler below can attach, so it must be caught here —
      // otherwise it escapes to defineTool as a context-free `Grep failed: spawn
      // <CODE>` that hides which path/cwd was at fault.
      let child;
      try {
        child = spawn(rgBin, rgArgs, { cwd: ctx.cwd, windowsHide: true });
      } catch (e: any) {
        resolve({ text: `Grep failed: could not start ripgrep (${e?.message ?? e}; rg=${rgBin}; cwd=${ctx.cwd}).`, isError: true });
        return;
      }
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => {
        if (out.length < 200_000) out += String(d);
      });
      child.stderr.on('data', (d) => {
        err += String(d);
      });
      const onAbort = () => child.kill('SIGKILL');
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      // Surface a spawn-level failure (rg missing, bad cwd) with the cwd actually
      // used, instead of letting it escape to defineTool's catch as a bare
      // `spawn <CODE>` — which hid this bug's cause for a whole session.
      child.on('error', (e) => {
        ctx.signal.removeEventListener('abort', onAbort);
        resolve({ text: `Grep failed: could not start ripgrep (${e.message}; cwd=${ctx.cwd}).`, isError: true });
      });
      child.on('close', (code) => {
        ctx.signal.removeEventListener('abort', onAbort);
        // An interrupt SIGKILLs rg → exit code null (not 2). Surface it as a
        // cancellation like Bash does, rather than resolving the partial output
        // as a successful search.
        if (ctx.signal.aborted) {
          resolve({ text: 'Canceled: the user interrupted this search.', isError: true });
          return;
        }
        // rg exit 1 = no matches (not an error); 2 = real error.
        if (code === 2) resolve({ text: grepErrorMessage(err, resolvedTarget, ctx.cwd), isError: true });
        else resolve({ text: out.trim() || 'No matches found.' });
      });
    });
  },
});
