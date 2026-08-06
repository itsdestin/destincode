// PTY-less exec (spec §2.3): none of the ConPTY 56-byte machinery applies —
// that is a CC-TUI constraint, not an exec constraint.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
// `which` ships no type declarations and @types/which is not a dependency here.
// Kept as a static import (not require) so the module-mocking layer can reach it
// — that is what makes gitBashCandidates() unit-testable off-Windows.
// @ts-ignore
import * as which from 'which';
import { z } from 'zod';
import { defineTool } from './registry';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/** Marker the shell prints after the user's command so we can read the final
 *  $PWD back out of stdout. Scoped-persistence (ROADMAP 2026-07-17): before
 *  this, every Bash call spawned fresh at the session root and `cd` silently
 *  evaporated, costing ~6 wasted tool calls in one observed session. */
const CWD_SENTINEL = '__YC_CWD__';

export interface ShellInfo { cmd: string; args: string[]; label: string }

/** Every place Git Bash might live, best first. Two hardcoded Program Files
 *  paths were the ENTIRE search before 2026-07-19, so a scoop/choco user-scope
 *  install (%LOCALAPPDATA%\Programs\Git), a D:\Git install, or any non-default
 *  location silently fell through to PowerShell — even though `git --version`
 *  passed first-run's prerequisite check and git.exe was right there on PATH. */
function gitBashCandidates(): string[] {
  const out: string[] = [];
  // Claude Code's own documented escape hatch for exactly this problem. Users
  // who already set it for the CLI get correct detection here for free.
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) out.push(process.env.CLAUDE_CODE_GIT_BASH_PATH);
  // Derive from git.exe on PATH: <root>\cmd\git.exe -> <root>\bin\bash.exe.
  // This is the branch that rescues every non-default install location.
  const git = resolveOnPath('git');
  if (git) {
    // path.win32 explicitly, not `path`: this branch only runs on win32 (where
    // they are the same), and naming it lets the test suite exercise Windows
    // path shapes from a Linux/macOS runner — POSIX dirname() does not treat
    // a backslash as a separator, so `path` here would be untestable off-Windows.
    const root = path.win32.dirname(path.win32.dirname(git));
    out.push(path.win32.join(root, 'bin', 'bash.exe'));
    out.push(path.win32.join(root, 'usr', 'bin', 'bash.exe'));
  }
  out.push('C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe');
  // Last resort: bash on PATH — but NEVER System32\bash.exe. That is the WSL
  // launcher: it would run the command inside a Linux VM against a Windows cwd,
  // so every path the model passed would be wrong. Worse than PowerShell.
  const onPath = resolveOnPath('bash');
  if (onPath && !/[\\/]system32[\\/]/i.test(onPath)) out.push(onPath);
  return out;
}

/** `which`-based resolution, mirroring resolveCommand() in prerequisite-installer.
 *  Returns null (not the bare name) so callers can tell "found" from "guessing". */
function resolveOnPath(cmd: string): string | null {
  try {
    // Static import, not a runtime require(): require() escapes the module
    // mocking layer, which made this branch impossible to unit-test.
    return (which as any).sync(cmd, { nothrow: true }) || null;
  } catch {
    return null;
  }
}

/** Windows shell preference (spec §2.3): Git Bash when present (models write
 *  bash), else PowerShell — and the tool DESCRIPTION states which is live. */
export function detectShell(): ShellInfo {
  if (process.platform !== 'win32') return { cmd: '/bin/bash', args: ['-c'], label: 'bash' };
  const gitBash = gitBashCandidates().find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (gitBash) return { cmd: gitBash, args: ['-c'], label: 'bash (Git Bash)' };
  // Loud, because this degrades the tool: no cwd persistence, and the model is
  // handed a shell its bash-shaped output does not fit. Silence here meant a
  // PowerShell fallback never appeared in a bug report (dev-tools.ts surfaces
  // it as the `harness shell` probe now).
  console.warn(
    '[harness/bash] Git Bash not found — falling back to PowerShell. ' +
      '`cd` will NOT persist between calls. Install Git for Windows, or set ' +
      'CLAUDE_CODE_GIT_BASH_PATH to your bash.exe.',
  );
  return { cmd: 'powershell.exe', args: ['-NoProfile', '-Command'], label: 'PowerShell' };
}

// LAZY + memoized, not module-load-time. First-run installs git via
// `winget install Git.Git` AFTER the app has started (main.ts -> ipc-handlers ->
// this module all import eagerly), so resolving at import pinned a brand-new
// Windows user to PowerShell for their whole first session even though the
// installer had just delivered bash.exe. Resolving on first USE — the earliest
// of buildAiTools() reading .description or an actual execute() — lands after
// first-run completes. Verified import chain: main.ts:8 -> ipc-handlers.ts:31.
let cachedShell: ShellInfo | null = null;
export function getShell(): ShellInfo {
  if (!cachedShell) cachedShell = detectShell();
  return cachedShell;
}
/** Test-only: drop the memo so a test can re-detect under a different platform. */
export function resetShellCache(): void {
  cachedShell = null;
}

/** Only the bash shells get cwd tracking. The PowerShell fallback would need a
 *  different sentinel AND an $LASTEXITCODE dance to preserve exit codes, and it
 *  only ever runs on Windows boxes without Git Bash — not worth the risk, so it
 *  stays stateless and the tool description says so. */
function tracksCwdFor(s: ShellInfo): boolean {
  return s.label.startsWith('bash');
}

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
function extractCwd(out: string): { text: string; cwd: string | null } {
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
    // .native FIRST: plain realpathSync does NOT expand Windows 8.3 short names.
    // ctx.cwd arrives short (C:\Users\RUNNER~1\...) while `pwd -W` may report the
    // SAME directory long (C:\Users\runneradmin\...), so startsWith() judged a
    // plain `cd sub` "outside the workspace" and the scope guard reverted EVERY
    // cd on Windows — persistence looked broken and each call emitted a bogus
    // reset notice. .native canonicalizes both sides via GetFinalPathNameByHandle.
    // Confirmed on windows-latest 2026-07-19 (short/long forms observed side by side).
    try {
      return fs.realpathSync.native(p);
    } catch {
      /* not on disk (yet) — fall back */
    }
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

/** Built per-read so it reflects the LAZILY resolved shell (see getShell). A
 *  module-level string would bake in whatever was detected at import — i.e.
 *  "PowerShell" for a user whose git arrived during first-run. */
function bashDescription(): string {
  const s = getShell();
  return (
    `Run a shell command (${s.label} on this machine). ` +
    (tracksCwdFor(s)
      ? 'The working directory PERSISTS between calls: a `cd` carries to your next Bash call. ' +
        'Changing directory outside the workspace root is reverted (you get a reset notice). ' +
        'Environment variables, aliases, and shell functions do NOT persist — each call is a fresh shell. ' +
        'Note that the other tools (Read/Edit/Write/Glob/Grep) resolve relative paths from the ' +
        'workspace root, NOT from this shell directory — prefer absolute paths with them. '
      : 'Each call starts fresh in the workspace directory — `cd` does NOT carry to the next call, ' +
        'so use absolute paths or chain with `cd X && ...` in one command. ') +
    'Output is capped; long-running commands time out (default 2 minutes, max 10 via timeout).'
  );
}

export const BashTool = defineTool({
  name: 'Bash',
  // Placeholder: the real text comes from the getter installed below, which
  // resolves the shell on first read (harness-session.ts buildAiTools()).
  description: '',
  // Compact form for small local models (simplified presentation, spec §4.2).
  // MERGE RECONCILIATION: stays a plain static string rather than joining the
  // lazy-getter dance — it names no shell, so there is nothing to resolve.
  shortDescription: 'Run a shell command and return its output.',
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
    const shell = getShell();
    const probe = tracksCwdFor(shell) && !/(\\|&&|\|\||\|)\s*$/.test(args.command);
    return new Promise((resolve) => {
      // spawn() throws SYNCHRONOUSLY when the shell path or startCwd has a
      // non-directory prefix (e.g. a stale/deleted tracked cwd that raced past
      // the existsSync check above). That throw fires before the 'error' handler
      // at the bottom of this executor can attach, so catch it here — otherwise
      // it escapes to defineTool as a bare `Bash failed: spawn <CODE>`.
      let child;
      try {
        child = spawn(shell.cmd, [...shell.args, probe ? withCwdProbe(args.command) : args.command], {
          cwd: startCwd,
          windowsHide: true,
          env: process.env,
        });
      } catch (e: any) {
        resolve({ text: `Failed to start shell: ${e?.message ?? e} (shell=${shell.cmd}; cwd=${startCwd})`, isError: true });
        return;
      }
      // Bounded head + rolling tail + an UNCONDITIONAL byte counter.
      //
      // WHY this replaced a flat 200KB accumulator (2026-08-06): the old buffer
      // retained 200KB only for defineTool to cut it to 30k, and — worse — the
      // truncation notice reported the CAPPED buffer's length as the original
      // size. A 5MB command was announced as "204800 chars total", a number
      // nothing had measured. Counting every chunk whether or not we keep it makes
      // the reported total true, and drops peak retention ~7x.
      const HEAD_CHARS = 24_000;
      const TAIL_CHARS = 6_000;
      let head = '';
      let tailBuf = '';
      let totalChars = 0;
      // Separate uncapped 4KB tail purely for the cwd sentinel: a chatty command
      // ("cd sub && <huge output>") would otherwise push the sentinel out of the
      // retained text and silently lose the cd.
      let probeTail = '';
      const cap = (s: string) => {
        totalChars += s.length;
        if (head.length < HEAD_CHARS) head += s;
        else tailBuf = (tailBuf + s).slice(-TAIL_CHARS);
        if (probe) probeTail = (probeTail + s).slice(-4096);
      };
      const joined = () => (tailBuf ? `${head}\n[...]\n${tailBuf}` : head);
      child.stdout.on('data', (d) => cap(String(d)));
      child.stderr.on('data', (d) => cap(String(d)));
      let done = false;
      const finish = (prefix: string, isError: boolean, code?: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        let body = joined();
        // WHY captured BEFORE extractCwd: the probe's `__YC_CWD__` sentinel line is
        // harness plumbing, not command output, and extractCwd strips it out of
        // `body` on virtually every non-Windows call. Comparing totalChars against
        // the POST-strip body would call that routine stripping a "drop" and
        // declare bogus bounds on every single Bash call, including 'echo hi' —
        // caught by the "declares no bounds for small output" test. Comparing
        // against the raw retained length (pre-strip) isolates the ONE thing that
        // should count as dropped: the head/tail accumulator actually cutting
        // real command output.
        const rawLen = body.length;
        let notice = '';
        // Bytes consumed by the probe's OWN generated sentinel line — harness
        // plumbing, not command output. Subtracted from the reported total so a
        // command that printed exactly 400,000 bytes is announced as 400,000, not
        // 400,000-plus-however-long-the-cwd-path-happens-to-be.
        let sentinelOverhead = 0;
        if (probe) {
          const parsed = extractCwd(joined());
          sentinelOverhead = rawLen - parsed.text.length;
          body = parsed.text;
          // Sentinel past the retention window → recover it from the uncapped tail.
          const reported = parsed.cwd ?? extractCwd(probeTail).cwd;
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
        // Only declare a bound when we actually dropped something. `total` is the
        // true byte count, `shown` what survived the head/tail retention.
        const dropped = totalChars > rawLen;
        resolve({
          text: text || `(no output, exit ${code ?? '?'})`,
          isError,
          bounds: dropped
            ? {
                shown: body.length,
                total: totalChars - sentinelOverhead,
                unit: 'bytes' as const,
                moreHint: 'pipe through head -n 100, tail -n 100, or wc -l to narrow it',
              }
            : undefined,
        });
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
      // Async spawn failure (the path Windows takes for a bad cwd): name the
      // shell + cwd actually used, not just Node's bare `spawn <cmd> <CODE>` —
      // same diagnosability contract as the sync catch above.
      child.on('error', (err) => finish(`Failed to start shell: ${err.message} (shell=${shell.cmd}; cwd=${startCwd})\n`, true));
      child.on('close', (code) => finish(code === 0 ? '' : `(exit code ${code})\n`, code !== 0, code));
    });
  },
});

// Installed AFTER defineTool because that helper spreads its input ({...def}),
// and a spread EVALUATES getters — declaring this inline would freeze the text
// at import, defeating the lazy resolve. buildAiTools() reads .description once
// per session (harness-session.ts), which is the moment we want detection.
Object.defineProperty(BashTool, 'description', {
  get: bashDescription,
  enumerable: true,
  configurable: true,
});
