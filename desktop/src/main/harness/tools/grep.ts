// Bundled ripgrep (@vscode/ripgrep) — deterministic cross-platform search.
import { spawn } from 'child_process';
import { rgPath as bundledRgPath } from '@vscode/ripgrep';
import * as fs from 'fs';
import * as path from 'path';
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

const MAX_COUNT = 500;

/** Which files hit `--max-count`, i.e. whose results are silently short.
 *
 *  WHY per-mode: --max-count means something different in each output mode, and
 *  in files_with_matches it cannot bind at all (`-l` stops at the first match).
 *  Reporting a cap there would be a false alarm; not reporting it in the other
 *  two modes is the silent truncation the 2026-08-01 review missed. */
export function filesAtMaxCount(out: string, mode: string, maxCount = MAX_COUNT): string[] {
  if (mode === 'files_with_matches') return [];
  const perFile = new Map<string, number>();
  for (const line of out.split('\n')) {
    if (!line) continue;
    if (mode === 'count') {
      const at = line.lastIndexOf(':');
      if (at === -1) continue;
      const n = Number(line.slice(at + 1));
      if (Number.isFinite(n)) perFile.set(line.slice(0, at), n);
    } else {
      const at = line.indexOf(':');
      if (at === -1) continue;
      const f = line.slice(0, at);
      perFile.set(f, (perFile.get(f) ?? 0) + 1);
    }
  }
  return [...perFile.entries()].filter(([, n]) => n >= maxCount).map(([f]) => f);
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
    const rgArgs = ['--no-config', '--hidden', '--glob', '!.git', '--max-count', String(MAX_COUNT)];
    if (mode === 'files_with_matches') rgArgs.push('-l');
    if (mode === 'count') rgArgs.push('--count');
    if (mode === 'content') rgArgs.push('-n');
    if (args.glob) rgArgs.push('--glob', args.glob);
    // Hoisted so the exit-2 error message (below) can name the exact path that
    // failed, instead of a context-free "ripgrep error".
    const resolvedTarget = resolveP(args.path ?? '.', ctx.cwd);
    // WHY a relative target: rg echoes back whatever form it was given, so an
    // absolute target made Grep print absolute paths while Glob printed relative
    // ones — the same file, two shapes, unpipeable between tools (2026-08-01
    // review). rg already runs with `cwd: ctx.cwd`, so a relative target is
    // equivalent. Targets OUTSIDE the workspace (reachable via the
    // external_directory ask) stay absolute, which is the truthful form there.
    // path.relative returns '' when the target IS cwd — map that to '.' rather
    // than falling through to the (also correct, but needlessly verbose) absolute form.
    const rel = path.relative(ctx.cwd, resolvedTarget);
    // Fix (Critical 2, 2026-08-06 review): rg echoes back exactly the path
    // argument it was given, and the old code passed '.' explicitly for the
    // "target is cwd" case — so a default, whole-workspace Grep printed
    // "./src/a.ts" while Glob (which never passes a path to fs.readdir)
    // printed "src/a.ts" for the SAME file: one file, two shapes, unpipeable
    // between the tools. Omitting the path argument entirely lets rg default
    // to its own cwd (already pinned via `cwd: ctx.cwd` in spawn() below) and
    // emit the same bare relative form Glob uses. Explicit relative/absolute
    // targets are unaffected — still passed through so rg reports them as-is.
    const searchTarget = rel === '' ? null : (!rel.startsWith('..') && !path.isAbsolute(rel) ? rel : resolvedTarget);
    if (searchTarget !== null) rgArgs.push('--', args.pattern, searchTarget);
    else rgArgs.push('--', args.pattern);
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
        // stdin: 'ignore' — WHY (found while verifying Critical 2's fix): with
        // Node's default stdio, fd 0 is an open, un-piped-into pipe. When no
        // path argument is present (the new omit-path branch above), ripgrep's
        // own heuristic is "no path + stdin is not a tty ⇒ search stdin, not
        // the cwd" — so the child spawned and then blocked forever waiting for
        // stdin input that would never arrive, hanging every default Grep
        // call. Explicit path/absolute targets never hit this (rg only applies
        // the heuristic when no path is given), so this is safe for those too.
        child = spawn(rgBin, rgArgs, { cwd: ctx.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e: any) {
        resolve({ text: `Grep failed: could not start ripgrep (${e?.message ?? e}; rg=${rgBin}; cwd=${ctx.cwd}).`, isError: true });
        return;
      }
      // Same honest-total scheme as Bash: count every byte, retain a bounded
      // head + tail. The old flat 200k ceiling made the reported total a lie —
      // it silently dropped everything past 200k with no notice at all.
      let head = '';
      let tailBuf = '';
      let totalChars = 0;
      let err = '';
      child.stdout.on('data', (d) => {
        const s = String(d);
        totalChars += s.length;
        if (head.length < 24_000) head += s;
        else tailBuf = (tailBuf + s).slice(-6_000);
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
        if (code === 2) {
          resolve({ text: grepErrorMessage(err, resolvedTarget, ctx.cwd), isError: true });
          return;
        }
        // Fix (Critical 1, 2026-08-06 review): the old `dropped` check compared
        // `totalChars` (a raw byte/char count) against `out.length` where `out`
        // is `.trim()`-ed — and ripgrep always terminates non-empty stdout with
        // a trailing '\n', which trim() strips on EVERY successful run whether
        // or not anything was actually dropped. That made `totalChars ===
        // out.length + 1` universally true, firing a fabricated truncation
        // notice ("showing 10 of 11 chars — narrow the pattern...") on 100% of
        // non-empty results, including ones that returned everything. Compare
        // against the UNTRIMMED accumulator instead: head/tailBuf together
        // equal every char received UNLESS the head cap was actually exceeded
        // (tailBuf only holds a bounded rolling window in that case) — the same
        // scheme bash.ts uses for its own `rawLen` check.
        const joined = tailBuf ? `${head}\n[...]\n${tailBuf}` : head;
        const dropped = totalChars > joined.length;
        const out = joined.trim();
        const capped = filesAtMaxCount(out, mode);
        if (!out) {
          resolve({ text: 'No matches found.' });
          return;
        }
        resolve({
          text: capped.length
            ? `${out}\n\nNote: these files hit the ${MAX_COUNT}-matches-per-file limit and have more: ${capped.join(', ')}`
            : out,
          bounds: dropped
            ? {
                // Fix: `out.length` used to include the synthetic "\n[...]\n"
                // separator (7 chars) inserted between head and tail — that
                // separator is harness plumbing, not ripgrep output, so
                // counting it overstated how much real content was shown.
                shown: out.length - 7,
                total: totalChars,
                unit: 'chars' as const,
                moreHint: 'narrow the pattern, add a glob filter, or use output_mode: "count"',
              }
            : undefined,
        });
      });
    });
  },
});
