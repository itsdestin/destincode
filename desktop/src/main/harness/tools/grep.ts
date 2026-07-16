// Bundled ripgrep (@vscode/ripgrep) — deterministic cross-platform search.
import { spawn } from 'child_process';
import { rgPath } from '@vscode/ripgrep';
import { z } from 'zod';
import { defineTool } from './registry';
import { resolveP } from './guards';

export const GrepTool = defineTool({
  name: 'Grep',
  description:
    'Search file contents with a regex (ripgrep). output_mode: "content" (matching lines), "files_with_matches" (default), or "count".',
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
    rgArgs.push('--', args.pattern, resolveP(args.path ?? '.', ctx.cwd));
    return new Promise((resolve) => {
      const child = spawn(rgPath, rgArgs, { windowsHide: true });
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
        if (code === 2)
          resolve({ text: `Grep failed: ${err.trim() || 'ripgrep error'}. Check the regex syntax.`, isError: true });
        else resolve({ text: out.trim() || 'No matches found.' });
      });
    });
  },
});
