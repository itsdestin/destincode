// PTY-less exec (spec §2.3): none of the ConPTY 56-byte machinery applies —
// that is a CC-TUI constraint, not an exec constraint.
import { spawn } from 'child_process';
import * as fs from 'fs';
import { z } from 'zod';
import { defineTool } from './registry';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/** Windows shell preference (spec §2.3): Git Bash when present (models write
 *  bash), else PowerShell — and the tool DESCRIPTION states which is live. */
export function detectShell(): { cmd: string; args: string[]; label: string } {
  if (process.platform !== 'win32') return { cmd: '/bin/bash', args: ['-c'], label: 'bash' };
  const gitBash = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe'].find((p) =>
    fs.existsSync(p),
  );
  if (gitBash) return { cmd: gitBash, args: ['-c'], label: 'bash (Git Bash)' };
  return { cmd: 'powershell.exe', args: ['-NoProfile', '-Command'], label: 'PowerShell' };
}

const shell = detectShell();

export const BashTool = defineTool({
  name: 'Bash',
  description:
    `Run a shell command (${shell.label} on this machine) in the workspace directory. ` +
    'Output is capped; long-running commands time out (default 2 minutes, max 10 via timeout).',
  inputSchema: z.object({
    command: z.string(),
    timeout: z.number().int().optional().describe('Timeout in milliseconds'),
    description: z.string().optional().describe('One line: what this command does'),
  }),
  caps: { maxChars: 30_000 },
  permissionSubject: (a) => a.command,
  async execute(args, ctx) {
    const timeout = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    return new Promise((resolve) => {
      const child = spawn(shell.cmd, [...shell.args, args.command], {
        cwd: ctx.cwd,
        windowsHide: true,
        env: process.env,
      });
      let out = '';
      const cap = (s: string) => {
        if (out.length < 200_000) out += s;
      };
      child.stdout.on('data', (d) => cap(String(d)));
      child.stderr.on('data', (d) => cap(String(d)));
      let done = false;
      const finish = (prefix: string, isError: boolean, code?: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        resolve({ text: `${prefix}${out}`.trim() || `(no output, exit ${code ?? '?'})`, isError });
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(`Command timed out after ${timeout}ms.\n`, true);
      }, timeout);
      // Interrupt kills the child (spec §2.1 interrupt-mid-tool ruling) and
      // resolves NOW — we can't wait for 'close', because on Windows a surviving
      // grandchild (e.g. bash → node) keeps the stdout pipe open, so 'close'
      // would never fire and the turn would hang.
      const onAbort = () => {
        child.kill('SIGKILL');
        finish('Canceled: the user interrupted this operation.\n', true);
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      // If the signal already fired before we attached (once:true won't replay), kill now.
      if (ctx.signal.aborted) onAbort();
      child.on('error', (err) => finish(`Failed to start shell: ${err.message}\n`, true));
      child.on('close', (code) => finish(code === 0 ? '' : `(exit code ${code})\n`, code !== 0, code));
    });
  },
});
