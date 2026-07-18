// PTY-less exec (spec §2.3): none of the ConPTY 56-byte machinery applies —
// that is a CC-TUI constraint, not an exec constraint.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { defineTool } from './registry';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/** Marker the shell prints after the user's command so we can read the final
 *  $PWD back out of stdout. Scoped-persistence (ROADMAP 2026-07-17): before
 *  this, every Bash call spawned fresh at the session root and `cd` silently
 *  evaporated, costing ~6 wasted tool calls in one observed session. */
const CWD_SENTINEL = '__YC_CWD__';

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

/** Only the bash shells get cwd tracking. The PowerShell fallback would need a
 *  different sentinel AND an $LASTEXITCODE dance to preserve exit codes, and it
 *  only ever runs on Windows boxes without Git Bash — not worth the risk, so it
 *  stays stateless and the tool description says so. */
const tracksCwd = shell.label.startsWith('bash');

/** Wrap the command so the shell prints its final $PWD without clobbering the
 *  exit code. Newline-separated (not `;`) so trailing `&`, `# comments`, and
 *  heredocs in the user's command don't turn into syntax errors. */
function withCwdProbe(command: string): string {
  // TRAILING newline is load-bearing: a background writer ('cmd &') can flush to
  // the pipe AFTER the sentinel, and without a terminator that text concatenates
  // onto the path — yielding a garbage cwd, a spurious reset notice, and output
  // silently dropped from the result. Verified 2026-07-18.
  // `pwd -W` is the MSYS/Git Bash builtin that prints a WINDOWS-style path
  // (C:/Users/...). Without it $PWD is /c/Users/... which path.resolve() on
  // Windows turns into C:\\c\\Users\\... — never inside ctx.cwd, so EVERY call
  // would emit a bogus reset notice. Invalid on Linux/macOS bash, where the
  // `|| pwd` fallback takes over (stderr suppressed so it can't reach output).
  return `${command}\n__yc_rc=$?\nprintf '\\n${CWD_SENTINEL}%s\\n' "$(pwd -W 2>/dev/null || pwd)"\nexit $__yc_rc`;
}

/** Split the sentinel back off the combined stdout+stderr. Returns the text the
 *  model should see and the reported cwd (null when the command exited early,
 *  timed out, or was killed — all cases where cwd simply doesn't change). */
export function extractCwd(out: string): { text: string; cwd: string | null } {
  const at = out.lastIndexOf(`\n${CWD_SENTINEL}`);
  if (at === -1) return { text: out, cwd: null };
  const after = out.slice(at + 1 + CWD_SENTINEL.length);
  const nl = after.indexOf('\n');
  const reported = (nl === -1 ? after : after.slice(0, nl)).trim();
  const rest = nl === -1 ? '' : after.slice(nl + 1);
  return { text: out.slice(0, at) + rest, cwd: reported || null };
}

/** Containment check for the scope guard. realpath both sides so a symlinked
 *  workspace root doesn't read as "outside itself". */
function isInside(root: string, candidate: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const r = real(root);
  const c = real(candidate);
  return c === r || c.startsWith(r + path.sep);
}

export const BashTool = defineTool({
  name: 'Bash',
  description:
    `Run a shell command (${shell.label} on this machine). ` +
    (tracksCwd
      ? 'The working directory PERSISTS between calls: a `cd` carries to your next Bash call. ' +
        'Changing directory outside the workspace root is reverted (you get a reset notice). ' +
        'Environment variables, aliases, and shell functions do NOT persist — each call is a fresh shell. ' +
        'Note that the other tools (Read/Edit/Write/Glob/Grep) resolve relative paths from the ' +
        'workspace root, NOT from this shell directory — prefer absolute paths with them. '
      : 'Each call starts fresh in the workspace directory — `cd` does NOT carry to the next call, ' +
        'so use absolute paths or chain with `cd X && ...` in one command. ') +
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
    // A tracked dir can be deleted out from under us (rm -rf, worktree remove);
    // falling back to the root beats spawning into ENOENT.
    const tracked = ctx.shellCwd;
    const startCwd =
      tracked && tracked !== ctx.cwd && fs.existsSync(tracked) && fs.statSync(tracked).isDirectory() ? tracked : ctx.cwd;
    // Skip the probe when the command's last line would ABSORB ours: a trailing
    // line-continuation, or a dangling `&&`/`||`/`|` (which swallows the
    // `__yc_rc=$?` line, so a FAILED command would exit 0 — verified 2026-07-18).
    // Such commands are malformed anyway; skipping restores the plain behavior.
    const probe = tracksCwd && !/(\\|&&|\|\||\|)\s*$/.test(args.command);
    return new Promise((resolve) => {
      const child = spawn(shell.cmd, [...shell.args, probe ? withCwdProbe(args.command) : args.command], {
        cwd: startCwd,
        windowsHide: true,
        env: process.env,
      });
      let out = '';
      // The 200KB cap below would drop the trailing sentinel on a chatty command
      // ("cd sub && <huge output>"), silently losing the cd. Keep a small rolling
      // tail that is never capped so the probe survives regardless of volume.
      let tail = '';
      const cap = (s: string) => {
        if (out.length < 200_000) out += s;
        if (probe) tail = (tail + s).slice(-4096);
      };
      child.stdout.on('data', (d) => cap(String(d)));
      child.stderr.on('data', (d) => cap(String(d)));
      let done = false;
      const finish = (prefix: string, isError: boolean, code?: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        let body = out;
        let notice = '';
        if (probe) {
          const parsed = extractCwd(out);
          body = parsed.text;
          // Sentinel past the 200KB cap → recover it from the uncapped tail.
          const reported = parsed.cwd ?? extractCwd(tail).cwd;
          if (reported && path.resolve(reported) !== path.resolve(startCwd)) {
            if (isInside(ctx.cwd, reported)) {
              ctx.setShellCwd?.(path.resolve(reported));
            } else {
              // Scope guard: don't let the session wander out of the workspace,
              // and TELL the model — a silent revert is the exact failure mode
              // the Claude Code issues (#35058 et al.) complain about.
              ctx.setShellCwd?.(ctx.cwd);
              notice = `\nShell cwd was reset to ${ctx.cwd} (${reported} is outside the workspace).`;
            }
          }
        }
        const text = (`${prefix}${body}`.trim() + notice).trim();
        resolve({ text: text || `(no output, exit ${code ?? '?'})`, isError });
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
